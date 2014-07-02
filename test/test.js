"use strict";

var Promise = require("bluebird"),
    cluster = require("cluster"),
    net     = Promise.promisifyAll(require("net")),
    clusterphone = require("../clusterphone");

// TODO: test namespaces don't collide.
// TODO: test payload data is correct.

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
      return spawnWorkerAndWait("server");
    }).then(function(worker) {
      return clusterphone.sendTo(worker, "server", {}, client);
    }).then(function() {
      return deferred.promise;
    });
  });

  it("sends messages to workers correctly", function() {
    return spawnWorkerAndWait("ack-cb").then(function(worker) {
      clusterphone.sendTo(worker, "foo", {bar: "quux"}).then(function(reply) {
        expect(reply).to.eql("recv");
      });
    });
  });

  it("queues messages up whilst workers are booting", function() {
    var worker = spawnWorker("ack");
    return clusterphone.sendTo(worker, "foo").then(function(reply) {
      expect(reply).to.eql("recv");
    });
  });

  it("refuses to queue messages bearing a descriptor", function() {
    var worker = spawnWorker("ack");

    expect(function() {
      clusterphone.sendTo(worker, "foo", {}, {fd: 123});
    }).to.throw(/tried to send an FD/);
  });

  it("handles acks correctly", function() {
    return spawnWorkerAndWait("ack-filtered").then(function(worker) {
      clusterphone.sendTo(worker, "foo").then(function() {
        throw new Error("I shouldn't have been ack'd.");
      });
      return clusterphone.sendTo(worker, "foo", {ackme: true}).then(function(reply) {
        expect(reply).to.equal("recv");
      });
    });
  });

  it("unhandled messages are an error", function() {
    var worker = spawnWorker("ack");

    return clusterphone.sendTo(worker, "unknown").then(function() {
      throw new Error("I shouldn't have been called.");
    }).error(function(err) {
      expect(err.message).to.match(/Unhandled message type/);
    });
  });

  it("handles unknown namespaces", function() {
    return spawnWorkerAndWait("ack").then(function(worker) {
      return clusterphone.ns("secret").sendTo(worker, "foo").then(function() {
        console.log(arguments);
        throw new Error("I shouldn't be called.");
      }).error(function(err) {
        expect(err.message).to.match(/unknown namespace/i);
      });
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
