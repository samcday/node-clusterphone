// This worker will echo "foo" messages on stdout.

var clusterphone = require("../../clusterphone");

setInterval(console.log.bind(null,"bitchin!"),100);
clusterphone.handlers.foo = function(data) {
  console.log(arguments);
  process.stdout.write(JSON.stringify(data));
}
