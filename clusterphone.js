"use strict";

var cluster = require("cluster"),
    Promise = require("bluebird"),
    semver  = require("semver"),
    pkg     = require("./package"),
    debug   = require("debug")("clusterphone:" + (cluster.isMaster ? "master" : "worker" + cluster.worker.id));

// We initialize ourselves in the global process space. This is so multiple
// versions of the library can co-exist harmoniously.
var clusterphone = process.__clusterphone,
    namespaces;

if (!clusterphone) {
  process.__clusterphone = clusterphone = {
    namespaces: {}
  };
  namespaces = clusterphone.namespaces;

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

function sendAck(namespaceName, seq, reply, error) {
  debug("Sending ack for message seq " + seq);
  this.send({
    __clusterphone: {
      ns: namespaceName,
      ack: seq,
      reply: reply,
      error: error,
    }
  });
};

function messageHandler(message, fd) {
  /*jshint validthis:true */
  if (!message || !message.__clusterphone) {
    return;
  }

  message = message.__clusterphone;

  var nsName = message.ns,
      ackNum = message.ack,
      seq = message.seq;

  if (!nsName || !namespaces.hasOwnProperty(nsName)) {
    debug("Got a message for unknown namespace '" + nsName + "'.");

    if (ackNum) {
      debug("Nonsensical: getting an ack for a namespace we don't know about.");
      return;
    }

    return sendAck.call(this, nsName, seq, null, "Unknown namespace.");
  }

  var namespace = namespaces[nsName];

  if (ackNum) {
    debug("Handling ack for seq " + ackNum);
    var pending = namespace.getPending.call(this, ackNum);
    if (!pending) {
      debug("Got an ack for a message that wasn't pending.");
      return;
    }
    if (!pending[0].monitored) {
      return;
    }
    if (message.error) {
      return pending[1](new Error(message.error));
    }
    return pending[0](message.reply);
  }

  var cmd = message.cmd,
      handler = namespace.interface.handlers[cmd];

  debug("Handling message seq " + seq + " " + cmd);

  if (!handler) {
    debug("Got a message I can't handle: " + cmd);
    return sendAck.call(this, nsName, seq, null, "Unhandled message type");
  }

  var handlerPromise = new Promise(function(resolve) {
    var result = handler(message.payload, fd, resolve);
    if (result && "function" === typeof result.then) {
      resolve(result);
    }
  });

  var self = this;

  handlerPromise.then(function(reply) {
    sendAck.call(self, nsName, seq, reply);
  }).catch(function(err) {
    debug("Caught error when running " + cmd + " handler.");
    debug(err);
  });
};

// If we're the first clusterphone to initialise, OR we're a newer version than
// the one that has already initialised, we use our message handler impl.
if (!clusterphone.version || semver.gt(pkg.version, clusterphone.version)) {
  if (clusterphone.version) {
    debug("Older version of clusterphone messageHandler being replaced by " + pkg.version);
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
};

function namespaced(namespaceName) {
  if (!namespaceName) {
    throw new TypeError("Name is required for namespaced messaging.");
  }

  var namespace = namespaces[namespaceName];
  if (namespace) {
    return namespace.interface;
  }

  debug("Setting up namespace for '" + namespaceName + "'");

  namespace = namespaces[namespaceName] = {
    interface: {}
  };
  namespace.interface.name = namespaceName;

  if (cluster.isMaster) {
    var workerDataAccessor = "__clusterphone";
    if ("undefined" !== typeof global.Symbol) {
      workerDataAccessor = Symbol();
    }

    // Gets our private data section from a worker object.
    var getWorkerData = function(worker) {
      if (!worker) {
        throw new TypeError("Trying to get private data for null worker?!");
      }

      var data = worker[workerDataAccessor];
      if (!data) {
        worker[workerDataAccessor] = data = {};
      }

      var namespacedData = data[namespaceName];
      if (!namespacedData) {
        data[namespaceName] = namespacedData = {
          seq: 1,
          pending: {},
          queued: []
        };
      }

      return namespacedData;
    };

    namespace.getPending = function(seq) {
      var workerData = getWorkerData(this);
      var pending = workerData.pending[seq];
      delete workerData.pending[seq];
      return pending;
    };

    var sendTo = function(worker, cmd, payload, fd) {
      if (!worker) {
        throw new TypeError("Worker must be specified");
      }

      if (worker.state === "dead") {
        throw new Error("Worker is dead. Can't send message to it.");
      }

      cmd = cmd ? String(cmd) : cmd;
      if (!cmd) {
        throw new Error("Command is required.");
      }

      var canSend = ["listening", "online"].indexOf(worker.state) > -1;
      if (!canSend && fd) {
        throw new Error("You tried to send an FD to a worker that isn't online yet." +
          "Whilst ordinarily I'd be happy to queue messages for you, deferring sending a descriptor could " +
          "cause strange behavior in your application.");
      }

      var workerData = getWorkerData(worker),
          seq = workerData.seq++,
          api = constructMessageApi(namespace, seq);

      workerData.pending[seq] = [api[1], api[2]];

      if (canSend) {
        debug("Sending message sequence " + seq + " " + cmd + " to worker " + worker.id);
        worker.send({
          __clusterphone: {
            ns: namespaceName,
            cmd: cmd,
            seq: seq,
            payload: payload
          }
        }, fd);
      } else {
        debug("Queueing message to " + worker.id);

        workerData.queued.push({
          cmd: cmd,
          seq: seq,
          payload: payload,
          api: api
        });
      }

      return api[0];
    };

    var sendQueued = function(worker) {
      var data = getWorkerData(worker);
      while(data.queued.length) {
        var item = data.queued.shift();

        worker.send({
          __clusterphone: {
            ns: namespaceName,
            cmd: item.cmd,
            seq: item.seq,
            payload: item.payload
          }
        });
      }
    };

    // If a worker dies, fail any monitored ack deferreds.
    var cleanPending = function(worker) {
      var data = getWorkerData(worker);

      Object.keys(data.pending).forEach(function(seqNum) {
        var item = data.pending[seqNum];
        delete data.pending[seqNum];
        if (item[0].monitored) {
          item[1](new Error("Undeliverable message: worker died before we could get acknowledgement"));
        }
      });
    };

    cluster.on("online", sendQueued);
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
        throw new Error("Command is required.");
      }

      debug("Sending message sequence " + seq + " " + cmd + " to master.");

      pendings[seq] = [api[1], api[2]];

      process.send({
        __clusterphone: {
          ns: namespaceName,
          seq: seq,
          cmd: cmd,
          payload: payload
        }
      }, fd);

      return api[0];
    };

    namespace.interface.handlers = {};
    namespace.interface.sendToMaster = sendToMaster;
  }

  return namespace.interface;
}

module.exports = namespaced("_");
module.exports.ns = namespaced;
module.exports.ackTimeout = 5 * 60 * 1000;  // 5 minutes by default.
