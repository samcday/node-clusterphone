"use strict";

var cluster = require("cluster"),
    Promise = require("bluebird"),
    semver  = require("semver"),
    pkg     = require("./package"),
    debug   = require("debug")("clusterphone:" + (cluster.isMaster ? "master" : "worker" + cluster.worker.id));

// We initialize ourselves in the global process space. This is so multiple
// versions of the library can co-exist harmoniously.
var clusterphone = process.__clusterphone,
    namespaces,
    internalNamespace,
    internalNameGuard = 0;  // We use this to prevent callers from obtaining the "clusterphone" namespace.

if (!clusterphone) {
  process.__clusterphone = clusterphone = {
    namespaces: {},
    workerDataAccessor: "__clusterphone",
  };
  namespaces = clusterphone.namespaces;

  /* istanbul ignore if */
  if ("undefined" !== typeof global.Symbol) {
    clusterphone.workerDataAccessor = Symbol();
  }

  // We only want to bind these once, and they dispatch to whatever
  // messageHandler has been set on the clusterphone global.
  if (cluster.isMaster) {
    cluster.on("fork", function(worker) {
      worker.on("message", function(message, fd) {
        clusterphone.messageHandler.call(worker, message, fd);
      });
    });
  } else {
    process.on("message", function(message, fd) {
      clusterphone.messageHandler.call(process, message, fd);
    });
  }
} else {
  namespaces = clusterphone.namespaces;
}

function sendAck(namespaceId, seq, reply, error) {
  /* jshint validthis:true */

  debug("Sending ack for message seq " + seq);
  this.send({
    __clusterphone: {
      ns: namespaceId,
      ack: seq,
      reply: reply,
      error: error,
    }
  });
}

function handleAck(ackNum, message, namespace) {
  /* jshint validthis:true */

  debug("Handling ack for seq " + ackNum);
  var pending = namespace.getPending.call(this, ackNum);

  /* istanbul ignore if */
  if (!pending) {
    debug("Got an ack for a message that wasn't pending.");
    return;
  }

  /* istanbul ignore if */
  if (!pending[0].monitored) {
    return;
  }

  if (message.error) {
    var error = new Error(message.error.msg ? message.error.msg : message.error);
    if (message.error.msg) {
      error.origMessage = message.error.origMessage;
      error.origStack = message.error.origStack;
    }
    return pending[1](error);
  }
  return pending[0](message.reply);
}

function fireMessageHandler(nsName, seq, handler, cmd, payload, fd) {
  /* jshint validthis:true */

  var args = [payload, fd];
  if (this !== process) {
    args.unshift(this);
  }

  var handlerPromise = new Promise(function(resolve, reject) {
    var ackSent = false,
        result;

    var acknowledge = function(reply) {
      if (ackSent) {
        throw new Error("Acknowledgement callback invoked twice from handler for " + cmd + ". Sounds like a bug in your handler.");
      }
      ackSent = true;
      resolve(reply);
    };
    args.push(acknowledge);

    try {
      result = handler.apply(null, args);
    } catch(err) {
      if (ackSent) {
        console.log("WARNING: handler for " + cmd + " threw an exception *after* already acknowledging. You have a bug in your handler :)", err.stack);
      } else {
        reject(err);
      }
      return;
    }

    if (result && "function" === typeof result.then) {
      if (ackSent) {
        console.log("WARNING: Handler for " + cmd + " invoked node-style acknowledgement callback, but then returned a promise. Ignoring the promise.");
        return;
      }
      resolve(result);
    }
  });

  var self = this;

  handlerPromise.then(function(reply) {
    sendAck.call(self, nsName, seq, reply);
  }).catch(function(err) {
    debug("Caught error when running " + cmd + " handler.");
    debug(err);
    sendAck.call(self, nsName, seq, null, {
      msg: "Message handler threw an error: " + err.message,
      origMessage: err.message,
      origStack: err.stack.split("\n").slice(1).join("\n")
    });
  });
}

function messageHandler(message, fd) {
  /* jshint validthis:true */

  /* istanbul ignore if */
  if (!message || !message.__clusterphone) {
    return;
  }

  message = message.__clusterphone;

  var nsName = message.ns,
      ackNum = message.ack,
      seq = message.seq;

  if (!nsName || !namespaces.hasOwnProperty(nsName)) {
    debug("Got a message for unknown namespace '" + nsName + "'.");

    /* istanbul ignore if */
    if (ackNum) {
      debug("Nonsensical: getting an ack for a namespace we don't know about.");
      return;
    }

    return sendAck.call(this, nsName, seq, null, "Unknown namespace.");
  }

  var namespace = namespaces[nsName];

  if (ackNum) {
    return handleAck.call(this, ackNum, message, namespace);
  }

  var cmd = message.cmd,
      handler = namespace.interface.handlers[cmd];

  debug("Handling message seq " + seq + " " + cmd);

  if (!handler) {
    debug("Got a message I can't handle: " + cmd);
    return sendAck.call(this, nsName, seq, null, "Unhandled message type");
  }

  fireMessageHandler.call(this, nsName, seq, handler, cmd, message.payload, fd);
}

// If we're the first clusterphone to initialise, OR we're a newer version than
// the one that has already initialised, we use our message handler impl.
/* istanbul ignore else */ // <--- there is no else path, istanbul thinks there is. Bug?
if (!clusterphone.version || semver.gt(pkg.version, clusterphone.version)) {
  if (clusterphone.version) {
    debug("Older version (" + clusterphone.version + ") of clusterphone messageHandler being replaced by " + pkg.version);
  }
  clusterphone.version = pkg.version;
  clusterphone.messageHandler = messageHandler;
}

// Build the object that we return from sendTo calls.
function constructMessageApi(namespace, seq) {
  var api = {},
      valid = true,
      timeout = module.exports.ackTimeout,
      resolve,
      reject;

  var promise = new Promise(function(_resolve, _reject) {
    resolve = _resolve;
    reject = _reject;
  });

  setImmediate(function() {
    valid = false;
  });

  api.within = function(newTimeout) {
    if (!valid) {
      throw new Error("within() / acknowledged() calls are only valid immediately after sending a message.");
    }
    if (resolve.monitored) {
      throw new Error("within() must be called *before* acknowledged()");
    }
    if ("number" !== typeof newTimeout) {
      newTimeout = parseInt(newTimeout, 10);
    }
    if(!newTimeout) {
      throw new Error("Timeout must be a number");
    }
    timeout = newTimeout;
    return api;
  };

  api.acknowledged = function(cb) {
    if (!valid) {
      throw new Error("within() / acknowledged() calls are only valid immediately after sending a message.");
    }
    // This flag indicates that the caller does actually care about the resolution of this acknowledgement.
    resolve.monitored = true;
    return promise.timeout(timeout)
        .catch(Promise.TimeoutError, function(e) {
          // We retrieve the pending here to ensure it's deleted.
          namespace.getPending(seq);
          throw e;
        })
        .nodeify(cb);
  };

  api.ackd = api.acknowledged;

  return [api, resolve, reject];
}

// Gets our private data section from a worker object.
function getWorkerData(worker) {
  /* istanbul ignore if */
  if (!worker) {
    throw new TypeError("Trying to get private data for null worker?!");
  }

  var data = worker[clusterphone.workerDataAccessor];
  if (!data) {
    worker[clusterphone.workerDataAccessor] = data = {};
  }

  return data;
}

function namespaced(namespaceId) {
  if (namespaceId === "clusterphone") {
    if (internalNameGuard === 0) {
      throw new Error("The 'clusterphone' namespace name is private. Sorry.");
    }
    internalNameGuard--;
  }

  if (!namespaceId) {
    throw new TypeError("Name is required for namespaced messaging.");
  }

  var namespace = namespaces[namespaceId];
  if (namespace) {
    return namespace.interface;
  }

  debug("Setting up namespace for '" + namespaceId + "'");

  namespace = namespaces[namespaceId] = {
    interface: {}
  };
  namespace.interface.name = namespaceId;

  if (cluster.isMaster) {
    var getWorkerNamespacedData = function(worker) {
      var workerData = getWorkerData(worker);
      var namespacedData = workerData[namespaceId];
      if (!namespacedData) {
        workerData[namespaceId] = namespacedData = {
          seq: 1,
          pending: {},
          queued: [],
          parent: workerData
        };
      }

      return namespacedData;
    };

    namespace.getPending = function(seq) {
      var workerData = getWorkerNamespacedData(this);
      var pending = workerData.pending[seq];
      delete workerData.pending[seq];
      return pending;
    };

    var sendTo = function(worker, cmd, payload, fd, forceSendFD) {
      if (!worker) {
        throw new TypeError("Worker must be specified");
      }

      var workerData = getWorkerNamespacedData(worker);

      if (worker.state === "dead") {
        throw new Error("Worker is dead. Can't send message to it.");
      }

      cmd = cmd ? String(cmd) : cmd;
      if (!cmd) {
        throw new TypeError("Command is required.");
      }

      var canSend = workerData.parent.isReady;

      if (!canSend && fd && forceSendFD !== true) {
        throw new TypeError("You tried to send an FD to a worker that isn't online yet. " +
          "Whilst ordinarily I'd be happy to queue messages for you, deferring sending a descriptor could " +
          "cause strange behavior in your application.");
      }

      var seq = workerData.seq++,
          api = constructMessageApi(namespace, seq);

      workerData.pending[seq] = [api[1], api[2]];

      if (canSend) {
        debug("Sending message sequence " + seq + " " + cmd + " to worker " + worker.id);
        worker.send({
          __clusterphone: {
            ns: namespaceId,
            cmd: cmd,
            seq: seq,
            payload: payload
          }
        }, fd);
      } else {
        debug("Queueing message " + cmd + " to worker #" + worker.id);

        workerData.queued.push({
          cmd: cmd,
          seq: seq,
          payload: payload,
          api: api,
          fd: fd
        });
      }

      return api[0];
    };

    namespace.workerReady = function(worker) {
      var data = getWorkerNamespacedData(worker);
      data.parent.isReady = true;

      if (data.queued.length) {
        debug("We have messages in " + namespaceId + " queued for worker " + worker.id + ". Sending them now.");
      }

      while(data.queued.length) {
        var item = data.queued.shift();

        worker.send({
          __clusterphone: {
            ns: namespaceId,
            cmd: item.cmd,
            seq: item.seq,
            payload: item.payload
          }
        }, item.fd);
      }

      worker.emit("clusterphone:online");
    };

    // If a worker dies, fail any monitored ack deferreds.
    var cleanPending = function(worker) {
      var data = getWorkerNamespacedData(worker);

      Object.keys(data.pending).forEach(function(seqNum) {
        var item = data.pending[seqNum];
        delete data.pending[seqNum];
        if (item[0].monitored) {
          item[1](new Error("Undeliverable message: worker died before we could get acknowledgement"));
        }
      });
    };

    cluster.on("disconnect", cleanPending);

    namespace.interface.handlers = {};
    namespace.interface.sendTo = sendTo;
  } else {
    var pendings = {},
        seqCounter = 1;

    namespace.getPending = function(seq) {
      var pending = pendings[seq];
      delete pendings[seq];
      return pending;
    };

    var sendToMaster = function(cmd, payload, fd) {
      var seq = seqCounter++,
          api = constructMessageApi(namespace, seq);

      cmd = cmd ? String(cmd) : cmd;
      if (!cmd) {
        throw new TypeError("Command is required.");
      }

      debug("Sending message sequence " + seq + " " + cmd + " to master.");

      pendings[seq] = [api[1], api[2]];

      try {
        process.send({
          __clusterphone: {
            ns: namespaceId,
            seq: seq,
            cmd: cmd,
            payload: payload
          }
        }, fd);
      } catch(e) {
        debug("Failed to send " + cmd + " in NS " + namespaceId + " to master.");
        debug(e);
        // We don't want to throw this synchronously. That's mean.
        // Instead we'll wait a tick and see if they registered an ack handler
        // for it.
        setImmediate(function() {
          /* istanbul ignore if */
          if (api[1].monitored) {
            api[2](e);
          }
        });
      }

      return api[0];
    };

    // If this ISN'T the internal namespace, we send a message to master
    // indicating that we are now ready for any queued messages for this ns.
    if (namespaceId !== "clusterphone") {
      internalNamespace.sendToMaster("workerReady", {
        targetNs: namespaceId
      });
    }

    namespace.interface.handlers = {};
    namespace.interface.sendToMaster = sendToMaster;
  }

  return namespace.interface;
}

internalNameGuard++;
internalNamespace = namespaced("clusterphone");

var defaultNamespace = namespaced("_");

if (cluster.isMaster) {
  internalNamespace.handlers.workerReady = function(worker, msg) {
    var targetNsName = msg.targetNs;

    /* istanbul ignore if */
    if (!targetNsName) {
      return;
    }

    var targetNs = namespaces[msg.targetNs];

    if (!targetNs) {
      debug("WEIRD: worker said it was ready for " + targetNsName + ", but we don't have that namespace.");
      return;
    }

    debug("Worker #" + worker.id + " is ready to receive messages for " + targetNsName);
    targetNs.workerReady(worker);
  };
}

module.exports = defaultNamespace;
module.exports.ns = namespaced;
module.exports.ackTimeout = 10 * 1000;  // 10 seconds by default.
