"use strict";

// This worker will ack "foo" messages via returned promise.

var clusterphone = require("../../clusterphone"),
    Promise = require("bluebird");

clusterphone.handlers.foo = function() {
  return Promise.resolve("recv");
};
