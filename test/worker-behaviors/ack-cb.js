// This worker will ack "foo" messages via callback.

var clusterphone = require("../../clusterphone");

clusterphone.handlers.foo = function(data, fd, ack) {
  ack("recv");
}
