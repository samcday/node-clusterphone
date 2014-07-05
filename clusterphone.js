"use strict";

var cluster = require("cluster"),
    Promise = require("bluebird"),
    semver  = require("semver"),
    pkg     = require("./package"),
    debug   = require("debug")("clusterphone:" + (cluster.isMaster ? "master" : "worker" + cluster.worker.id));

var clusterphone = require("./nucleus"),
    messageBus = require("./message-bus");

// If we're the first clusterphone to initialise, OR we're a newer version than
// the one that has already initialised, we use our message handler impl.
/* istanbul ignore else */ // <--- there is no else path, istanbul thinks there is. Bug?
if (!clusterphone.version || semver.gt(pkg.version, clusterphone.version)) {
  if (clusterphone.version) {
    debug("Older version (" + clusterphone.version + ") of clusterphone messageBus being replaced by " + pkg.version);
  }
  clusterphone.version = pkg.version;
  clusterphone.messageBus = messageBus;
}

var internalNamespace,
    internalNameGuard = 0;  // We use this to prevent callers from obtaining the "clusterphone" namespace.

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

  var namespace = clusterphone.namespaces[namespaceId];
  if (namespace) {
    return namespace.interface;
  }

  debug("Setting up namespace for '" + namespaceId + "'");

  namespace = clusterphone.namespaces[namespaceId] = {
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

    var targetNs = clusterphone.namespaces[msg.targetNs];

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
