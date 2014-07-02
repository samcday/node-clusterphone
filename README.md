# clusterphone

Easy-mode messaging between your `cluster` master <--> workers.

## Quickstart

Send messages to workers from your master:

    var clusterphone = require("clusterphone").ns("myapp");
    var worker = cluster.fork();
    clusterphone.sendTo(worker, "foo", {key: "Value"});

Handle messages from master in your worker:

    var clusterphone = require("clusterphone").ns("myapp");
    clusterphone.handlers.foo = function(payload) {
        console.log(payload.key); // --> "value"
    };
