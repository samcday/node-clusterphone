"use strict";

var clusterphone = require("../../clusterphone"),
    Promise = require("bluebird");

clusterphone.handlers.ack = function() {
  return Promise.resolve("recv");
};

clusterphone.handlers.ackCallback = function(data, fd, ack) {
  ack("cb");
};

clusterphone.handlers.echo = function(data) {
  return Promise.resolve(data);
};

clusterphone.handlers.namespaced = function() {
  return Promise.resolve("incorrect");
};
clusterphone.ns("secret").handlers.namespaced = function() {
  return Promise.resolve("correct");
};

clusterphone.handlers.server = function(data, socket, ack) {
  socket.write("hello");
  socket.end();

  socket.on("end", ack);
};

clusterphone.handlers.ackFiltered = function(data) {
  if (data.ackme === true) {
    return Promise.resolve("recv");
  }
};

clusterphone.handlers.exit = function() {
    process.exit();
}

clusterphone.handlers.noAck = function() {

}

clusterphone.handlers.fail = function() {
  throw new Error("EXPLOSIONS!");
}

clusterphone.handlers.reject = function() {
  return Promise.reject(new Error("EXPLOSIONS!"));
}
