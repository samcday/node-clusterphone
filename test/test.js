"use strict";

var Promise = require("bluebird"),
    cluster = require("cluster"),
    net     = Promise.promisifyAll(require("net")),
    clusterphone = require("../clusterphone");

// TODO: test acknowledgements
// TODO: test acknowledgements on dead workers
// TODO: test ack timeouts
// TODO: enforce within() BEFORE ackd()

var expect = require("chai").expect;

Promise.onPossiblyUnhandledRejection(function(e) {
  throw e;
});

var spawnWorker = function(behavior) {
  var worker = cluster.fork({BEHAVIOR: behavior});
  return worker;
};

var spawnWorkerAndWait = function(behavior) {
  return new Promise(function(resolve) {
    var worker = spawnWorker(behavior);
    worker.on("online", resolve.bind(null, worker));
  });
};

describe("clusterphone", function() {
  before(function() {
    cluster.setupMaster({
      exec: __dirname + "/worker-entrypoint.js"
    });
  });

  afterEach(function() {
    // Forcibly stop all workers.
    Object.keys(cluster.workers).forEach(function(workerId) {
      cluster.workers[workerId].kill();
    });

    Object.keys(clusterphone.handlers).forEach(function(handler) {
      delete clusterphone.handlers[handler];
    });
  });

  it("default namespace is _", function() {
    expect(clusterphone.name).to.eql("_");
  });

  it("refuses to dispatch to null worker", function() {
    expect(function() {
      clusterphone.sendTo(null);
    }).to.throw(TypeError);
  });

  it("sends descriptors correctly", function() {
    var server = Promise.promisifyAll(net.createServer()),
        client;

    after(function() {
      server.close();
    });

    var deferred = Promise.defer();
    server.on("connection", function(c) {
      c.on("data", function(data) {
        expect(data.toString()).to.eql("hello");
        deferred.resolve();
      });
    });

    return server.listenAsync().then(function() {
      client = net.createConnection(server.address().port);
      return spawnWorkerAndWait("standard");
    }).then(function(worker) {
      return clusterphone.sendTo(worker, "server", {}, client).ackd();
    }).then(function() {
      return deferred.promise;
    });
  });

  it("sends message data to workers correctly", function() {
    return spawnWorkerAndWait("standard").then(function(worker) {
      clusterphone.sendTo(worker, "echo", {bar: "quux"}).ackd().then(function(reply) {
        expect(reply).to.deep.eql({bar: "quux"});
      });
    });
  });

  it("handles node cb style acking from workers", function() {
    return spawnWorkerAndWait("standard").then(function(worker) {
      clusterphone.sendTo(worker, "ackCallback").ackd().then(function(reply) {
        expect(reply).to.eql("cb");
      });
    });
  });

  it("handles node cb style acking for master", function(done) {
    spawnWorkerAndWait("standard").then(function(worker) {
      clusterphone.sendTo(worker, "ack").ackd(function(err, reply) {
        expect(reply).to.eql("recv");
        done();
      });
    });
  });

  it("queues messages up whilst workers are booting", function() {
    var worker = spawnWorker("standard");
    return clusterphone.sendTo(worker, "ack").ackd().then(function(reply) {
      expect(reply).to.eql("recv");
    });
  });

  it("refuses to queue messages bearing a descriptor", function() {
    var worker = spawnWorker("standard");

    expect(function() {
      clusterphone.sendTo(worker, "server", {}, {fd: 123});
    }).to.throw(/tried to send an FD/);
  });

  it("handles acks correctly", function() {
    return spawnWorkerAndWait("standard").then(function(worker) {
      clusterphone.sendTo(worker, "ackFiltered").ackd().then(function() {
        throw new Error("I shouldn't have been ack'd.");
      });
      return clusterphone.sendTo(worker, "ackFiltered", {ackme: true}).ackd().then(function(reply) {
        expect(reply).to.equal("recv");
      });
    });
  });

  it("unhandled messages are an error", function() {
    var worker = spawnWorker("standard");

    return clusterphone.sendTo(worker, "unknown").ackd().then(function() {
      throw new Error("I shouldn't have been called.");
    }).error(function(err) {
      expect(err.message).to.match(/Unhandled message type/);
    });
  });

  it("handles unknown namespaces", function() {
    return spawnWorkerAndWait("standard").then(function(worker) {
      return clusterphone.ns("unknownns").sendTo(worker, "namespaced").ackd().then(function() {
        throw new Error("I shouldn't be called.");
      }).error(function(err) {
        expect(err.message).to.match(/unknown namespace/i);
      });
    });
  });

  it("prevents namespace collisions", function() {
    return spawnWorkerAndWait("standard").then(function(worker) {
      return clusterphone.ns("secret").sendTo(worker, "namespaced").ackd().then(function(reply) {
        expect(reply).to.eql("correct");
      });
    });
  });

  it("correctly sends messages to master from worker", function() {
    spawnWorker("send");

    return new Promise(function(resolve) {
      clusterphone.handlers.foo = function(data) {
        expect(data.bar).to.eql("quux");
        resolve();
      };
    });
  });

  it("correctly sends acks from master to worker", function() {
    spawnWorker("send");

    clusterphone.handlers.foo = function() {
      return Promise.resolve("ok");
    };

    return new Promise(function(resolve) {
      clusterphone.handlers.gotack = function(ackReply) {
        expect(ackReply).to.eql("ok");
        resolve();
      };
    });
  });

  it("older versions of library does not overwrite globals", function() {
    var worker = spawnWorker("older-version");

    return clusterphone.sendTo(worker, "version").ackd().then(function(reply) {
      expect(reply).to.deep.equal(require("../package").version);
    });
  });

  it("older versions of library receives messages and sends acks correctly", function() {
    var worker = spawnWorker("older-version");

    return clusterphone.sendTo(worker, "echo", {bar: "quux"}).ackd().then(function(reply) {
      expect(reply).to.deep.equal({bar: "quux"});
    });
  });

  it("older versions of library sends messages and receives acks correctly", function() {
    var worker = spawnWorker("older-version");

    var pongData;
    clusterphone.handlers.pong = function(data) {
      pongData = data;
      return Promise.resolve();
    };

    return clusterphone.sendTo(worker, "ping").ackd().then(function() {
      expect(pongData).to.deep.equal({bar: "quux"});
    });
  });

  it("older version in custom namespace receives messages correctly", function() {
    var worker = spawnWorker("older-version");

    return clusterphone.ns("secret").sendTo(worker, "echo", {bar: "quux"}).ackd().then(function(reply) {
      expect(reply).to.deep.equal({secret: {bar: "quux"}});
    });
  });

  // it("undeliverable queued messages will error", function() {
  //   var worker = spawnWorker("exit");

  //   return clusterphone.sendTo(worker, "foo").then(function() {
  //     throw new Error("I shouldn't have been called.");
  //   }).error(function(err) {
  //     expect(err.message).to.match(/Undeliverable/);
  //   });
  // });
});
