"use strict";

var clusterphone = require("../../clusterphone");

clusterphone.handlers.server = function(data, socket, ack) {
  socket.write("hello");
  socket.end();

  socket.on("end", ack);
};
