// This worker will ack "foo" messages if the args are correct.

var clusterphone = require("../../clusterphone");
var Promise = require("bluebird");

clusterphone.handlers.foo = function(data, fd) {
  if (data.ackme === true) {
    return Promise.resolve("recv");
  }
}
