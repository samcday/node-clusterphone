"use strict";

var cluster = require("cluster"),
    Promise = require("bluebird"),
    semver  = require("semver"),
    pkg     = require("./package"),
    debug   = require("debug")("clusterphone:" + (cluster.isMaster ? "master" : "worker" + cluster.worker.id));

var blackholePromise = new Promise(function() {});

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

    var sendTo = function(worker, cmd, payload, fd, cb) {
      if (!worker) {
        throw new TypeError("Worker must be specified");
      }

      if (!cb && "function" === typeof fd) {
        cb = fd;
        fd = null;
      }

      var workerData = getWorkerData(worker);

      if (["listening", "online"].indexOf(worker.state) === -1) {
        if (fd) {
          throw new Error("You tried to send an FD to a worker that isn't online yet." +
            "Whilst ordinarily I'd be happy to queue messages for you, deferring sending a descriptor could " +
            "cause strange behavior in your application.");
        }
        debug("Queueing message to " + worker.id);

        return new Promise(function(resolve, reject) {
          workerData.queued.push({
            cmd: cmd,
            payload: payload,
            resolve: resolve,
            reject: reject
          });
        }).nodeify(cb);
      }

      var seq = workerData.seq++;

      debug("Sending message sequence " + seq + " " + cmd + " to worker " + worker.id);

      var promise = new Promise(function(resolve, reject) {
        var message = {
          __clusterphone: {
            ns: namespaceName,
            cmd: cmd,
            seq: seq,
            payload: payload
          }
        };

        workerData.pending[seq] = [resolve, reject];

        worker.send(message, fd);
      });

      return promise.timeout(module.exports.ackTimeout)
        .catch(Promise.TimeoutError, function() {
          delete workerData.pending[seq];
          if (!module.exports.ignoreAckTimeouts) {
            throw new Error("Timed out waiting for acknowledgement.");
          } else {
            return blackholePromise;
          }
        })
        .nodeify(cb);
    };

    var sendQueued = function(worker) {
      var data = getWorkerData(worker);
      while(data.queued.length) {
        var item = data.queued.shift();
        item.resolve(sendTo(worker, item.cmd, item.payload, undefined));
      }
    };

    // var cleanPending = function(worker) {
    //   var data = getWorkerData(worker);

    //   Object.keys(data.pending).forEach(function(seqNum) {
    //     var item = data.pending[seqNum];
    //     delete data.pending[seqNum];
    //     item[1](new Error("Undeliverable message: worker died before we could get acknowledgement"));
    //   });
    // };

    cluster.on("online", sendQueued.bind(null));

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

    var sendToMaster = function(cmd, payload, fd, cb) {
      if (!cb && "function" === typeof fd) {
        cb = fd;
        fd = null;
      }

      var seq = seqCounter++;
      var message = {
        __clusterphone: {
          ns: namespaceName,
          seq: seq,
          cmd: cmd,
          payload: payload
        }
      };

      debug("Sending message sequence " + seq + " " + cmd + " to master.");

      var promise = new Promise(function(resolve, reject) {
        pendings[seq] = [resolve, reject];
      });

      process.send(message, fd);
      return promise.timeout(module.exports.ackTimeout)
        .catch(Promise.TimeoutError, function() {
          delete pendings[seq];
          if (!module.exports.ignoreAckTimeouts) {
            throw new Error("Timed out waiting for acknowledgement.");
          } else {
            return blackholePromise;
          }
        })
        .nodeify(cb);
    };

    namespace.interface.handlers = {};
    namespace.interface.sendToMaster = sendToMaster;
  }

  return namespace.interface;
}

module.exports = namespaced("_");
module.exports.ns = namespaced;
module.exports.ackTimeout = 5 * 60 * 1000;  // 5 minutes by default.
module.exports.ignoreAckTimeouts = false;
