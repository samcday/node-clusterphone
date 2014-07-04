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


## Replies

You can be notified when the remote end has handled your message. This is called an "acknowledgement". Acknowledgements can optionally include a reply payload.

    // Send a message to a worker from master, expecting the worker to acknowledge our message.
    clusterphone.sendTo(worker, "hello").acknowledged(function(err, reply) {
        console.log(reply);     // Will be `{hello: "world"}` - see below.
    });

    // From worker, handle the message from master, and send an acknowledgement.
    clusterphone.handlers.hello = function(data, fd, cb) {
        cb(null, { hello: "world"});
    }

`clusterphone` also provides a Promise-based API. Here's the previous example, using promises.

    // From master
    clusterphone.sendTo(worker, "hello").acknowledged().then(function(reply) {
        console.log(reply);
    });

    // From worker
    clusterphone.handlers.hello = function(data, fd) {
        return Promise.resolve({hello: "world"});
        // Note that for safety reasons, you have to return an actual then-able
        // from your handlers in order for the Promise API to work.
    }

The `acknowledged()` method also has a shorthand form of `ackd()`.

### Replies and timeouts

Note that when opting into receiving acknowledgements after dispatching a method, you're indicating that you're expecting a reply. If a reply is not received before a configurable timeout, then the callback/Promise will be invoked with a timeout error.

For example, the following code will error:

    // master
    clusterphone.sendTo(worker, "hello").acknowledged(function(err, reply) {
        // ...
    });

    // worker
    clusterphone.handlers.hello = function() {
        // Deliberately not acknowledging message here
    }

This will result in slightly weird behaviour unfortunately - the acknowledgement handler will fail after the default timeout of 30 seconds. You can change the timeout on a per message ack handler basis with a fluent API...

    clusterphone.sendTo(worker, "hello").within(5000 /* milliseconds */).ackd(function(err, reply) {
        // err will be a timeout error if remote end does not acknowledge within 5 seconds.
    })

... or you can change it globally.

    clusterphone.ackTimeout = 123;  // milliseconds

Acknowledgement handlers can be fired with an error if the remote end is a worker that died before acknowledging the message.

    // worker
    clusterphone.handlers.hello = function() {
        process.exit();
    }

    // master
    clusterphone.sendTo(worker, "hello").ackd(function(err, reply) {
        // err will be an Error indicating the worker died before acknowledging.
    });


## Namespacing

When initializing clusterphone, you can opt into a namespace, as was shown in the Quickstart:

    var clusterphone = require("clusterphone")("myapp");

If you don't specify a namespace, your messages and handlers will operate in the default "`_`" namespace. If you're writing an app, this should be okay, but if you're using clusterphone in a library you expect others to use, you really *should* specify a namespace.


## Contributing

Contributions are welcome! Please ensure submitted code is tested, and conforms to linting rules and spacing rules set out in [.editorconfig](.editorconfig) and [.jshintrc](.jshintrc).

Tests can be run with the usual `npm test`.


## License 

clusterphone is released under the [MIT License](LICENSE).
