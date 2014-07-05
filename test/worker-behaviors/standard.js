"use strict";

var clusterphone = require("../../clusterphone"),
    Promise = require("bluebird");

var expect = require("chai").expect;

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
    require("cluster").worker.kill();
};

clusterphone.handlers.noAck = function() {

};

clusterphone.handlers.fail = function() {
  throw new Error("EXPLOSIONS!");
};

clusterphone.handlers.reject = function() {
  return Promise.reject(new Error("EXPLOSIONS!"));
};

clusterphone.handlers.doubleAck = function(data, fd, ack) {
  ack();

  expect(function() {
    ack();
  }).to.throw(/callback invoked twice/i);
  clusterphone.sendToMaster("doubleAckReply");
};

clusterphone.handlers.cbThenPromise = function(data, fd, ack) {
  ack("correct");
  return Promise.resolve("incorrect.");
};

clusterphone.handlers.ackThenError = function(data, fd, ack) {
  ack("correct");
  throw new Error("KABOOOOOM!");
};
