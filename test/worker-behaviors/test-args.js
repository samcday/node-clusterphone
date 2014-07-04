"use strict";

var clusterphone = require("../../clusterphone"),
    Promise = require("bluebird"),
    expect = require("chai").expect;

expect(function() {
    clusterphone.sendToMaster();
}).to.throw(/command is required/i);

process.exit();