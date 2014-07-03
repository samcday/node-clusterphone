# clusterphone

[![Build Status](https://travis-ci.org/samcday/clusterphone.svg?branch=master)](https://travis-ci.org/samcday/clusterphone) [![Dependency Status](https://david-dm.org/samcday/clusterphone.svg)](https://david-dm.org/samcday/clusterphone)

Easy-mode messaging between your `cluster` master <--> workers.

## Quickstart

`npm install clusterphone`

Start up clusterphone, optionally choose a namespace.

    var clusterphone = require("clusterphone");
    // Or...
    var clusterphone = require("clusterphone").ns("myapp");

Send messages to workers from your master:

    var worker = cluster.fork();
    clusterphone.sendTo(worker, "foo", {key: "Value"});

Handle messages from master in your worker:

    clusterphone.handlers.foo = function(payload) {
        console.log(payload.key); // --> "value"
    };

Just like with the underlying Node.js `cluster` IPC messaging tools, you can send file descriptors to the remote. This can be done from both workers and master.

    var connection = net.createConnection({host: "google.com", port: 80});
    clusterphone.sendToMaster("socket", {}, connection);

## Acknowledgements

You can be notified when the remote end has handled your message. Acknowledgements can optionally include a reply payload.

    // From master
    clusterphone.sendTo(worker, "foo", {bar:"quux"}, function(err, reply) {
        console.log(reply);     // Will be "This is a reply!", see below.
    });

    // From worker
    clusterphone.handlers.foo = function(data, fd, cb) {
        cb(null, "This is a reply!");
    }

clusterphone also provides a Promise-based API. Here's the previous example, using promises.

    // From master
    clusterphone.sendTo(worker, "foo", {bar:"quux"}).then(function(reply) {
        console.log(reply);     // Will be "This is a reply!", see below.
    });

    // From worker
    clusterphone.handlers.foo = function(data, fd) {
        return Promise.resolve("This is a reply!");
    }

## Contributing

Contributions are welcome! Please ensure submitted code is tested, and conforms to linting rules and spacing rules set out in [.editorconfig](.editorconfig) and [.jshintrc](.jshintrc).

Tests can be run with the usual `npm test`.

## License 

clusterphone is released under the [MIT License](LICENSE).
