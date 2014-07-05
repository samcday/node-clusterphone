# clusterphone

[![Build Status](https://travis-ci.org/samcday/clusterphone.svg?branch=master)](https://travis-ci.org/samcday/clusterphone) [![Dependency Status](https://david-dm.org/samcday/clusterphone.svg)](https://david-dm.org/samcday/clusterphone) [![Code Climate](https://codeclimate.com/github/samcday/clusterphone.png)](https://codeclimate.com/github/samcday/clusterphone) [![Code Climate](https://codeclimate.com/github/samcday/clusterphone/coverage.png)](https://codeclimate.com/github/samcday/clusterphone)

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


## Sending messages

### Master -> Worker

Sending messages from your master to a worker is easy.

    var worker = cluster.fork();
    clusterphone.sendTo(worker, "foo", {key: "value"}, optionalFileDescriptor);

clusterphone will transparently queue your messages if the worker is still starting up and not yet ready to receive them.

### Worker -> Master

Sending a message from your worker to the master is also easy!

    clusterphone.sendToMaster("foo", {key: "value"}, optionalFileDescriptor);


## Receiving

Receiving messages on the other end is simple: just attach a handler to `clusterphone.handlers`. Here's some examples.

### Worker

    clusterphone.handlers.foo = function(data, fd) {
        // ...
    }

### Master

The master is mostly the same, except the first argument will be the worker that the message originated from.

    clusterphone.handlers.foo = function(worker, data, fd) {
        // ...
    }


## Sending Descriptors

Just like with the underlying Node.js `cluster` IPC messaging tools, you can send file descriptors to the other end. This can be done from both workers and master.

    // From a worker.
    var connection = net.createConnection({host: "google.com", port: 80});
    clusterphone.sendToMaster("socket", {}, connection);

    // From master.
    var worker = cluster.fork();
    var connection = net.createConnection({host: "google.com", port: 80});
    worker.on("online", function() {
        clusterphone.sendTo(worker, "socket", {}, connection);
    });

### Queueing and sending descriptors

Note how in the case of the master we waited until it was online before sending it a descriptor. If you try to send a message with a descriptor to a worker that is not yet ready, _clusterphone will be default throw an Error preventing you from doing this_. This is because sending descriptors results in the immediate removal of underlying handle, but if the message is queued this will not happen until some undetermined later stage. If you're sure you know what you're doing, you can do this:

    // From master.
    var worker = cluster.fork();
    var connection = net.createConnection({host: "google.com", port: 80});
    clusterphone.sendTo(worker, "socket", {}, connection, true); // Pass true as the last argument to force clusterphone to queue up your message along with the descriptor.

You must ensure you don't try and do anything more with the descriptor once you've opted to send it though.


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

Note that when opting into receiving acknowledgements after dispatching a method, you're indicating that you're expecting a reply. If a reply is not received before a configurable (default *10 seconds*) timeout, then the callback/Promise will be invoked with a timeout error.

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

If you don't specify a namespace, your messages and handlers will operate in the default "`_`" namespace. If you're writing an app, this should be okay. If you're using clusterphone in a library you expect others to use, you really *should* specify a namespace.


## Contributing

Contributions are welcome! Please ensure submitted code is tested, and conforms to linting rules and spacing rules set out in [.editorconfig](.editorconfig) and [.jshintrc](.jshintrc).

Tests can be run with the usual `npm test`.


## License 

clusterphone is released under the [MIT License](LICENSE).
