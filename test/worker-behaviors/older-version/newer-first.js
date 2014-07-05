"use strict";

// This worker entrypoint will bring in two different versions of clusterphone.
// First the newer version, and then the older.

require("../../../clusterphone");

var clusterphone = require("clusterphone"),
    Promise = require("bluebird");

clusterphone.handlers.version = function() {
  return Promise.resolve(process.__clusterphone.version);
};
