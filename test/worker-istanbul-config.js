var cluster = require("cluster");

exports.reporting = {  
  print: "none",
  reports: [ "json" ],
  dir: "coverage/worker-" + cluster.worker.id
};
