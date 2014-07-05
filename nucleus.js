"use strict";

var cluster = require("cluster");

// We initialize ourselves in the global process space. This is so multiple
// versions of the library can co-exist harmoniously.
var clusterphone = process.__clusterphone;

if (!clusterphone) {
  process.__clusterphone = clusterphone = {
    namespaces: {},
    workerDataAccessor: "__clusterphone",
  };

  /* istanbul ignore if */
  if ("undefined" !== typeof global.Symbol) {
    clusterphone.workerDataAccessor = Symbol();
  }

  // We only want to bind these once, and they dispatch to whatever messageBus
  // has been set on the clusterphone global (latest version of library will
  // win out)
  if (cluster.isMaster) {
    cluster.on("fork", function(worker) {
      worker.on("message", function(message, fd) {
        clusterphone.messageBus.call(worker, message, fd);
      });
    });
  } else {
    process.on("message", function(message, fd) {
      clusterphone.messageBus.call(process, message, fd);
    });
  }
}

module.exports = clusterphone;
