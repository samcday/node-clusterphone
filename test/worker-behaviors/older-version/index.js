"use strict";

// This worker entrypoint will bring in two different versions of clusterphone
// to test backwards compatibility.

var clusterphone = require("clusterphone"),
    Promise = require("bluebird");

require("../../../clusterphone");

clusterphone.handlers.version = function() {
  return Promise.resolve(process.__clusterphone.version);
};

clusterphone.handlers.echo = function(data) {
  return Promise.resolve(data);
};

clusterphone.handlers.ping = function() {
  return clusterphone.sendToMaster("pong", {bar: "quux"}).ackd();
};

clusterphone.ns("secret").handlers.echo = function(data) {
    return Promise.resolve({secret: data});
};
