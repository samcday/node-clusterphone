require("../../../clusterphone");

var clusterphone = require("clusterphone"),
    Promise = require("bluebird");

clusterphone.handlers.version = function(data) {
  return Promise.resolve(process.__clusterphone.version);
};

clusterphone.handlers.echo = function(data) {
  return Promise.resolve(data);
};

clusterphone.handlers.ping = function() {
  return clusterphone.sendToMaster("pong", {bar: "quux"});
}

clusterphone.ns("secret").handlers.echo = function(data) {
    return Promise.resolve({secret: data});
};