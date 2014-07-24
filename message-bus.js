"use strict";

var cluster = require("cluster"),
    Promise = require("bluebird"),
    debug   = require("debug")("clusterphone:" + (cluster.isMaster ? "master" : "worker" + cluster.worker.id) + ":messagebus");

var clusterphone = require("./nucleus");

function sendAck(namespaceId, seq, reply, error) {
  /* jshint validthis:true */

  debug("Sending ack for message seq " + seq);
  try {
    this.send({
      __clusterphone: {
        ns: namespaceId,
        ack: seq,
        reply: reply,
        error: error,
      }
    });
  } catch(e) {
    // Swallow errors about channel being closed. Not a lot we can do about that.
    /* istanbul ignore next */
    if (e.message.indexOf("channel closed") > -1) {
      debug("Looks like other end went away when trying to ack seq " + seq + ".");
      return;
    }
    /* istanbul ignore next */
    throw e;
  }
}

function handleAck(ackNum, message, namespace) {
  /* jshint validthis:true */

  debug("Handling ack for seq " + ackNum);
  var pending = namespace.getPending.call(this, ackNum);

  /* istanbul ignore if */
  if (!pending) {
    debug("Got an ack for a message that wasn't pending.");
    return;
  }

  /* istanbul ignore if */
  if (!pending[0].monitored) {
    return;
  }

  if (message.error) {
    var error = new Error(message.error.msg ? message.error.msg : message.error);
    if (message.error.msg) {
      error.origMessage = message.error.origMessage;
      error.origStack = message.error.origStack;
    }
    return pending[1](error);
  }
  return pending[0](message.reply);
}

function fireMessageHandler(nsName, seq, handler, cmd, payload, fd) {
  /* jshint validthis:true */

  var args = [payload, fd];
  if (this !== process) {
    args.unshift(this);
  }

  var handlerPromise = new Promise(function(resolve, reject) {
    var ackSent = false,
        result;

    var acknowledge = function(reply) {
      if (ackSent) {
        throw new Error("Acknowledgement callback invoked twice from handler for " + cmd + ". Sounds like a bug in your handler.");
      }
      ackSent = true;
      resolve(reply);
    };
    args.push(acknowledge);

    try {
      result = handler.apply(null, args);
    } catch(err) {
      if (ackSent) {
        console.log("WARNING: handler for " + cmd + " threw an exception *after* already acknowledging. You have a bug in your handler :)", err.stack);
      } else {
        reject(err);
      }
      return;
    }

    if (result && "function" === typeof result.then) {
      if (ackSent) {
        console.log("WARNING: Handler for " + cmd + " invoked node-style acknowledgement callback, but then returned a promise. Ignoring the promise.");
        return;
      }
      resolve(result);
    }
  });

  var self = this;

  handlerPromise.then(function(reply) {
    return sendAck.call(self, nsName, seq, reply);
  }).catch(function(err) {
    debug("Caught error when running " + cmd + " handler.");
    debug(err);
    return sendAck.call(self, nsName, seq, null, {
      msg: "Message handler threw an error: " + err.message,
      origMessage: err.message,
      origStack: err.stack.split("\n").slice(1).join("\n")
    });
  });
}

module.exports = function messageBus(message, fd) {
  /* jshint validthis:true */

  /* istanbul ignore if */
  if (!message || !message.__clusterphone) {
    return;
  }

  message = message.__clusterphone;

  var nsName = message.ns,
      ackNum = message.ack,
      seq = message.seq;

  if (!nsName || !clusterphone.namespaces.hasOwnProperty(nsName)) {
    debug("Got a message for unknown namespace '" + nsName + "'.");

    /* istanbul ignore if */
    if (ackNum) {
      debug("Nonsensical: getting an ack for a namespace we don't know about.");
      return;
    }

    return sendAck.call(this, nsName, seq, null, "Unknown namespace.");
  }

  var namespace = clusterphone.namespaces[nsName];

  if (ackNum) {
    return handleAck.call(this, ackNum, message, namespace);
  }

  var cmd = message.cmd,
      handler = namespace.interface.handlers[cmd];

  debug("Handling message seq " + seq + " " + cmd);

  if (!handler) {
    debug("Got a message I can't handle: " + cmd);
    return sendAck.call(this, nsName, seq, null, "Unhandled message type");
  }

  fireMessageHandler.call(this, nsName, seq, handler, cmd, message.payload, fd);
};
