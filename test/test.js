"use strict";

var Promise = require("bluebird"),
    cluster = require("cluster"),
    net     = Promise.promisifyAll(require("net")),
    clusterphone = require("../clusterphone"),
    sinon = require("sinon");

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
    worker.on("clusterphone:online", resolve.bind(null, worker));
  });
};

describe("clusterphone", function() {
  var server = Promise.promisifyAll(net.createServer());

  before(function() {
    // If we're running under istanbul, we change entrypoint to be istanbul
    // and make sure each worker gets a different directory for coverage.
    var exec = __dirname + "/worker-entrypoint.js";
    var args = [];

    if (process.env.npm_config_coverage) {
      console.log("Running with coverage instrumentation");
      args = ["test", "--config", __dirname + "/worker-istanbul-config.js", exec];
      exec = __dirname + "/../node_modules/.bin/istanbul";
    }

    cluster.setupMaster({
      exec: exec,
      args: args,
    });

    return server.listenAsync();
  });

  afterEach(function(done) {
    var isDone = false;
    // Forcibly stop all workers.
    cluster.disconnect(function() {
      isDone = true;
      done();
    });

    setTimeout(function() {
      if (isDone) {
        return;
      }
      Object.keys(cluster.workers).forEach(function(workerId) {
        cluster.workers[workerId].kill();
      });
      done();
    }, 1000);

    Object.keys(clusterphone.handlers).forEach(function(handler) {
      delete clusterphone.handlers[handler];
    });

    server.removeAllListeners();
  });

  after(function() {
    server.close();
  });

  it("default namespace is _", function() {
    expect(clusterphone.name).to.eql("_");
  });

  it("forbids access to 'clusterphone' namespace", function() {
    expect(function() {
      clusterphone.ns("clusterphone");
    }).to.throw(/is private/);
  });

  it("fails on empty namespace name.", function() {
    expect(function() {
      clusterphone.ns("");
    }).to.throw(/name is required/i);
  });

  it("does not create duplicate namespaces", function() {
    var ns1 = clusterphone.ns("dupetest");
    var ns2 = clusterphone.ns("dupetest");
    expect(ns1).to.eql(ns2);
  });

  it("refuses to dispatch to null worker", function() {
    expect(function() {
      clusterphone.sendTo(null);
    }).to.throw(TypeError);
  });

  it("refuses to dispatch to a worker that is gone", function(done) {
    var worker = spawnWorker("exit");

    worker.on("exit", function() {
      expect(function() {
        clusterphone.sendTo(worker, "resurrect");
      }).to.throw(/worker is dead/i);
      done();
    });
  });

  it("master refuses to dispatch an empty or null command", function() {
    var worker = spawnWorker("exit");
    expect(function() {
      clusterphone.sendTo(worker);
    }).to.throw(/command is required/i);

    expect(function() {
      clusterphone.sendTo(worker, "");
    }).to.throw(/command is required/i);

    expect(function() {
      clusterphone.sendTo(worker, []);
    }).to.throw(/command is required/i);
  });

  it("worker refuses to dispatch an empty or null command", function(done) {
    var worker = spawnWorker("test-args");

    worker.on("exit", function(code) {
      expect(code).to.equal(0);
      done();
    });
  });

  it("sends descriptors correctly", function() {
    var deferred = Promise.defer();
    server.once("connection", function(c) {
      c.on("data", function(data) {
        expect(data.toString()).to.eql("hello");
        deferred.resolve();
      });
    });

    var client = net.createConnection(server.address().port);

    return spawnWorkerAndWait("standard").then(function(worker) {
      return clusterphone.sendTo(worker, "server", {}, client).ackd();
    }).then(function() {
      return deferred.promise;
    });
  });

  it("refuses to queue filedescriptors to a worker", function() {
    var worker = spawnWorker("standard");

    expect(function() {
      var client = net.createConnection(server.address().port);
      clusterphone.sendTo(worker, "foo", {}, client);
    }).to.throw(/tried to send an FD/);
  });

  it("will queue file descriptor if forced to.", function() {
    var client = net.createConnection(server.address().port);
    var worker = spawnWorker("standard");

    var deferred = Promise.defer();
    server.once("connection", function(c) {
      c.on("data", function(data) {
        expect(data.toString()).to.eql("hello");
        deferred.resolve();
      });
    });

    return clusterphone.sendTo(worker, "server", {}, client, true).ackd().then(function() {
      return deferred.promise;
    });
  });

  it("sends message data to workers correctly", function() {
    return spawnWorkerAndWait("standard").then(function(worker) {
      return clusterphone.sendTo(worker, "echo", {bar: "quux"}).ackd().then(function(reply) {
        expect(reply).to.deep.eql({bar: "quux"});
      });
    });
  });

  it("handles node cb style acking from workers", function(done) {
    return spawnWorkerAndWait("standard").then(function(worker) {
      clusterphone.sendTo(worker, "ackCallback").ackd().then(function(reply) {
        expect(reply).to.eql("cb");
        done();
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

  it("fails acknowledgement if worker dies before acking", function() {
    var worker = spawnWorker("standard");
    return clusterphone.sendTo(worker, "exit").ackd()
      .then(function() {
        throw new Error("I shouldn't be called.");
      })
      .catch(function(err) {
        expect(err.message).to.match(/worker died/i);
      });
  });

  it("errors on undeliverable queued messages", function() {
    var worker = spawnWorker("exit");

    return clusterphone.sendTo(worker, "foo").ackd().then(function() {
      throw new Error("I shouldn't have been called.");
    }).error(function(err) {
      expect(err.message).to.match(/worker died/);
    });
  });

  it("times out acknowledgements correctly", function() {
    var clock;

    setImmediate(function() {
      clock.tick(clusterphone.ackTimeout + 1);
    });

    after(function() {
      clock.restore();
    });

    clock = sinon.useFakeTimers();

    var worker = spawnWorker("standard");
    return clusterphone.sendTo(worker, "noAck").ackd()
      .then(function() {
        console.log("Hrm2.");
        throw new Error("I shouldn't be called.");
      })
      .catch(function(err) {
        expect(err.message).to.match(/timed out/);
        clock.restore();
      });
  });

  it("errors on double acks correctly", function() {
    var worker = spawnWorker("standard");

    var promise = new Promise(function(resolve) {
      clusterphone.handlers.doubleAckReply = function() {
        resolve();
      };
    });

    return clusterphone.sendTo(worker, "doubleAck").ackd().then(function() {
      return promise;
    });
  });

  it("ignores returned Promise if node ack is invoked", function() {
    var worker = spawnWorker("standard");

    return clusterphone.sendTo(worker, "cbThenPromise").ackd().then(function(reply) {
      expect(reply).to.equal("correct");
    });
  });

  it("ignores errors thrown after acknowledgement is invoked", function() {
    var worker = spawnWorker("standard");

    return clusterphone.sendTo(worker, "ackThenError").ackd().then(function(reply) {
      expect(reply).to.equal("correct");
    });
  });

  it("respects explicit timeout properly", function() {
    var clock;

    setImmediate(function() {
      clock.tick(50);
    });
    after(function() {
      clock.restore();
    });

    clock = sinon.useFakeTimers();

    var worker = spawnWorker("standard");
    return clusterphone.sendTo(worker, "noAck").within(10).ackd()
      .then(function() {
        throw new Error("I shouldn't be called.");
      })
      .catch(function(err) {
        expect(err.message).to.match(/timed out/);
        clock.restore();
      });
  });

  it("refuses to allow timeout to be specified once ack handler is set", function() {
    var worker = spawnWorker("standard");

    expect(function() {
      var api = clusterphone.sendTo(worker, "ack");
      api.ackd().catch(function() {});
      api.within();
    }).to.throw(/within.* must be called/);
  });

  it("refuses to allow handler to be specified after next tick", function(done) {
    var worker = spawnWorker("standard");
    var api = clusterphone.sendTo(worker, "ack");

    setImmediate(function() {
      expect(function() {
        api.ackd();
      }).to.throw(/calls are only valid immediately/);

      expect(function() {
        api.within();
      }).to.throw(/calls are only valid immediately/);
      done();
    });
  });

  it("within requires a number", function() {
    var worker = spawnWorker("standard");
    
    expect(function() {
      clusterphone.sendTo(worker, "ack").within();
    }).to.throw(/must be a number/);

    expect(function() {
      clusterphone.sendTo(worker, "ack").within("bacon");
    }).to.throw(/must be a number/);
  });

  it("refuses to queue messages bearing a descriptor", function() {
    var worker = spawnWorker("standard");

    expect(function() {
      clusterphone.sendTo(worker, "server", {}, {fd: 123});
    }).to.throw(/tried to send an FD/);
  });

  it("handles acks correctly", function() {
    return spawnWorkerAndWait("standard").then(function(worker) {
      return clusterphone.sendTo(worker, "ackFiltered", {ackme: true}).acknowledged().then(function(reply) {
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
      return clusterphone.ns("unknowns").sendTo(worker, "namespaced").ackd().then(function() {
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
    var worker = spawnWorker("send");

    return new Promise(function(resolve) {
      clusterphone.handlers.foo = function(fromWorker, data) {
        expect(fromWorker).to.eql(worker);
        expect(data.bar).to.eql("quux");
        resolve();
        return Promise.resolve();
      };
    });
  });

  it("correctly sends acks from master to worker", function() {
    spawnWorker("send");

    clusterphone.handlers.foo = function() {
      return Promise.resolve("ok");
    };

    return new Promise(function(resolve) {
      clusterphone.handlers.gotack = function(worker, ackReply) {
        expect(ackReply).to.eql("ok");
        resolve();
        return Promise.resolve();
      };
    });
  });

  it("newer version overrides older one", function() {
    var worker = spawnWorker("older-version");

    return clusterphone.sendTo(worker, "version").ackd().then(function(reply) {
      expect(reply).to.deep.equal(require("../package").version);
    });
  });

  it("older versions of library does not overwrite globals", function() {
    var worker = spawnWorker("older-version/newer-first");

    return clusterphone.sendTo(worker, "version").ackd().then(function(reply) {
      expect(reply).to.deep.equal(require("../package").version);
    });
  });

  it("older versions of library receives and acks messages correctly", function() {
    var worker = spawnWorker("older-version");

    return clusterphone.sendTo(worker, "echo", {bar: "quux"}).ackd().then(function(reply) {
      expect(reply).to.deep.equal({bar: "quux"});
    });
  });

  it("older versions of library sends messages and receives acks correctly", function() {
    var worker = spawnWorker("older-version");

    var pongData;
    clusterphone.handlers.pong = function(worker, data) {
      pongData = data;
      return Promise.resolve();
    };

    return clusterphone.sendTo(worker, "ping").ackd().then(function() {
      expect(pongData).to.deep.equal({bar: "quux"});
    });
  });

  it("older version in custom namespace receives messages correctly", function() {
    return spawnWorkerAndWait("older-version").then(function(worker) {
      return clusterphone.ns("secret").sendTo(worker, "echo", {bar: "quux"}).ackd().then(function(reply) {
        expect(reply).to.deep.equal({secret: {bar: "quux"}});
      });
    });
  });

  it("older version in custom namespace receives queued messages correctly", function() {
    var worker = spawnWorker("older-version");

    return clusterphone.ns("secret").sendTo(worker, "echo", {bar: "quux"}).ackd().then(function(reply) {
      expect(reply).to.deep.equal({secret: {bar: "quux"}});
    });
  });

  it("handler errors propagate back and fail acknowledged", function() {
    var worker = spawnWorker("standard");

    return clusterphone.sendTo(worker, "fail").ackd()
      .then(function() {
        throw new Error("I shouldn't be called.");
      })
      .catch(function(err) {
        expect(err.message).to.match(/message handler threw an error/i);
        expect(err.origStack).to.exist;
        expect(err.origMessage).to.equal("EXPLOSIONS!");
      });
  });

  it("handler explicit rejections propagate back and fail acknowledged", function() {
    var worker = spawnWorker("standard");

    return clusterphone.sendTo(worker, "reject").ackd()
      .then(function() {
        throw new Error("I shouldn't be called.");
      })
      .catch(function(err) {
        expect(err.message).to.match(/message handler threw an error/i);
        expect(err.origStack).to.exist;
        expect(err.origMessage).to.equal("EXPLOSIONS!");
      });
  });
});
