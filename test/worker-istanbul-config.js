var cluster = require("cluster");

exports.reporting = {  
  print: "none",
  reports: [ "lcovonly" ],
  dir: "coverage/worker/" + cluster.worker.id
};
