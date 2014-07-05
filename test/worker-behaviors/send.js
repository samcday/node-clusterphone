"use strict";

var clusterphone = require("../../clusterphone");

clusterphone.sendToMaster("foo", { bar: "quux" }).ackd().then(function(reply) {
  if (reply) {
    clusterphone.sendToMaster("gotack", reply).ackd();
  }
});
