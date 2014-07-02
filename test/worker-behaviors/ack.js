// This worker will ack "foo" messages via returned promise.

var clusterphone = require("../../clusterphone"),
    Promise = require("bluebird");

clusterphone.handlers.foo = function(data, fd) {
  return Promise.resolve("recv");
}
