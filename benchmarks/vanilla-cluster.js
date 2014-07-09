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

  worker.on("message", function() {
    bytes += payloadSize * 2;
    if (running) {
      worker.send(payload);
    } else {
      cluster.disconnect();
    }
  });

  worker.on("online", function() {
    start = Date.now();
    worker.send(payload);

    setTimeout(function() {
      var end = Date.now();

      var throughput = bytes / (end - start) / 1024 / 1024;
      running = false;

      console.log("Sent " + bytes + ". " + throughput + "MB/s");
    }, 10000);
  });
} else {
  process.on("message", function() {
    process.send(payload);
  });
}
