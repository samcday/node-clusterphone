# clusterphone

[![Build Status](https://travis-ci.org/samcday/clusterphone.svg?branch=master)](https://travis-ci.org/samcday/clusterphone) [![Dependency Status](https://david-dm.org/samcday/clusterphone.svg)](https://david-dm.org/samcday/clusterphone)

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
