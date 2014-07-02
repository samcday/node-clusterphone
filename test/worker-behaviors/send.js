"use strict";

// This worker will ack "foo" messages via returned promise.

var clusterphone = require("../../clusterphone"),
    Promise = require("bluebird");

clusterphone.sendToMaster("foo", { bar: "quux" }).then(function(reply) {
  clusterphone.sendToMaster("gotack", reply);
});