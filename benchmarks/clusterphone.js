var clusterphone = require("../clusterphone");
var cluster = require("cluster");

var payload = {
  data: {
    type: "payload",
    reason: "benchmarking",
    awesome: true,
    levelOfAwesome: 9001
  }
};
var payloadSize = JSON.stringify(payload).length;

if (cluster.isMaster) {
  var bytes = 0;
  var start;
  var running = true;

  var worker = cluster.fork();

  clusterphone.handlers.message = function() {
    bytes += payloadSize * 2;
    if (running) {
      clusterphone.sendTo(worker, "message", payload);
    } else {
      cluster.disconnect();
    }
  };

  start = Date.now();
  clusterphone.sendTo(worker, "message", payload);

  setTimeout(function() {
    var end = Date.now();

    var throughput = bytes / (end - start) / 1024 / 1024;
    running = false;

    console.log("Sent " + bytes + ". " + throughput + "MB/s");
  }, 10000);
} else {
  clusterphone.handlers.message = function() {
    clusterphone.sendToMaster("message", payload);
  }
}
