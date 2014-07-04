"use strict";

var clusterphone = require("../../clusterphone"),
    Promise = require("bluebird");

clusterphone.sendToMaster("foo", { bar: "quux" }).ackd().then(function(reply) {
  clusterphone.sendToMaster("gotack", reply).ackd();
});