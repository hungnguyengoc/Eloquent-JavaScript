// A collection of hacks that attempts to do as much sanity checking
// of the code in the source for a chapter as possible, without
// requiring excessive annotation.

var fs = require("fs");
var acorn = require("acorn");

var file = process.argv[2];
var chapNum = Number(file.match(/^\d*/)[0]);
var input = fs.readFileSync(file, "utf8");

var baseCode = "var alert = function() {}, prompt = function() { return 'x'; }, confirm = function() { return true; }; window = this; requestAnimationFrame = setTimeout = clearTimeout = setInterval = clearInterval = Math.min; var localStorage = {setItem: function(a, b) { this[a] = b;}, getItem: function(a) { return this[a] || null; }, removeItem: function(a) { delete this[a]; }};\n";

var include = /\n:load_files: (\[[^\]]+\])/.exec(input);
if (include) JSON.parse(include[1]).forEach(function(fileName) {
  var text = fs.readFileSync("html/" + fileName);
  if (!/\/\/ test: no/.test(text))
    baseCode += text;
});

function wrapTestOutput(snippet, config) {
  var output = "", m, re = /\/\/ → (.*\n)((?:\/\/   .*\n)*)/g;
  while (m = re.exec(snippet)) {
    output += m[1];
    if (m[2]) output += m[2].replace(/\/\/   /g, "");
  }
  return "console.clear();\n" + snippet + "console.verify(" + JSON.stringify(output) + ", " + JSON.stringify(config) + ");\n";
}

function wrapForError(snippet, message) {
  return "try { (function() {\n" + snippet + "})();\n" +
    "console.missingErr();\n} catch (_e) { console.compareErr(_e, " +
    JSON.stringify(message) + "); }\n";
}

function pos(index) {
  return "line " + (input.slice(0, index).split("\n").length + 1);
}

var sandboxes = {}, anonId = 0;

var re = /((?:\/\/.*\n|\s)*)(?:\[sandbox="([^"]*)"\]\n|\[.*\n)*\[source,([^\]]+)\]\n----\n([\s\S]*?\n)----/g, m;
while (m = re.exec(input)) {
  var snippet = m[4], hasConf = m[1].match(/\/\/ test: (.*)/);
  var sandbox = m[2] || "null", type = m[3], config = hasConf ? hasConf[1] : "";
  var where = pos(m.index);

  if (type != "javascript" && type != "text/html") continue;

  var boxId = m[2] || (type == "javascript" ? "null" : "box" + (++anonId));
  var sandbox = sandboxes[boxId];
  if (!sandbox)
    sandbox = sandboxes[boxId] = {code: ""};

  if (/\bnever\b/.test(config)) continue;
  if (type == "text/html") {
    var stripped = stripHTML(snippet);
    snippet = stripped.javascript;
  }
  try {
    acorn.parse(snippet, {strictSemicolons: chapNum != 1});
  } catch(e) {
    console.log("parse error at " + where + ": " + e.toString());
  }
  if (/\bno\b/.test(config)) continue;
  if (m = config.match(/\berror "([^"]+)"/)) snippet = wrapForError(snippet, m[1]);
  else if (/\/\/ →/.test(snippet)) snippet = wrapTestOutput(snippet, config);
  if (/\bwrap\b/.test(config)) snippet = "(function(){\n" + snippet + "}());\n";

  if (type == "text/html") {
    if (sandbox.html) console.log("Double HTML for box " + boxId);
    sandbox.html = stripped.html;
    sandbox.code = stripped.included + "console.pos = " + JSON.stringify(where) + ";\n" + snippet + sandbox.code;
  } else {
    sandbox.code += "console.pos = " + JSON.stringify(where) + ";\n";
    sandbox.code += snippet;
  }
}

function stripHTML(code) {
  var included = "", script = "";
  code = code.replace(/<script\b[^>]*?(?:\bsrc\s*=\s*('[^']+'|"[^"]+"|[^\s>]+)[^>]*)?>([\s\S]*?)<\/script>/, function(m, src, content) {
    if (src) {
      if (/["']/.test(src.charAt(0))) src = src.slice(1, src.length - 1);
      included += fs.readFileSync("html/" + src, "utf8");
    } else {
      script += content;
    }
    return "";
  });
  return {html: code, included: included, javascript: script};
}

function represent(val) {
  if (typeof val == "boolean") return String(val);
  if (typeof val == "number") return String(val);
  if (typeof val == "string") return JSON.stringify(val);
  if (val == null) return String(val);
  if (Array.isArray(val)) return representArray(val);
  else return representObj(val);
}

function representArray(val) {
  var out = "[";
  for (var i = 0; i < val.length; ++i) {
    if (i) out += ", ";
    out += represent(val[i]);
    if (out.length > 80) return out;
  }
  return out + "]";
}

function representObj(val) {
  var string = val.toString(), m, elt;
  if (/^\[object .*\]$/.test(string))
    return representSimpleObj(val);
  if (val.call && (m = string.match(/^\s*(function[^(]*\([^)]*\))/)))
    return m[1] + "{…}";
  return string;
}

function constructorName(obj) {
  if (!obj.constructor) return null;
  var m = String(obj.constructor).match(/^function\s*([^\s(]+)/);
  if (m && m[1] != "Object") return m[1];
}

function hop(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

function representSimpleObj(val) {
  var out = "{", name = constructorName(val);
  if (name) out = name + " " + out;
  var first = true;
  for (var prop in val) if (hop(val, prop)) {
    if (out.length > 80) return out;
    if (first) first = false;
    else out += ", ";
    out += prop + ": " + represent(val[prop]);
  }
  return out + "}";
}

function compareClipped(a, b) {
  a = a.split("\n");
  b = b.split("\n");
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; ++i) {
    var len = Math.max(0, a[i].length - 1);
    if (a[i].slice(0, len) != b[i].slice(0, len)) return false;
  }
  return true;
}

function compareJoined(a, b) {
  return a.replace(/\n\s*/g, " ").trim() == b.replace(/\n\s*/g, " ").trim();
}

var accum = "", _console = {
  clear: function() { accum = ""; },
  log: function() {
    for (var i = 0; i < arguments.length; i++) {
      if (i) accum += " ";
      if (typeof arguments[i] == "string")
        accum += arguments[i];
      else
        accum += represent(arguments[i]);
    }
    accum += "\n";
  },
  verify: function(string, config) {
    var clip = string.indexOf("…"), ok = false;
    if (/\btrailing\b/.test(config)) accum = accum.replace(/\s+(\n|$)/g, "$1");
    if (/\btrim\b/.test(config)) { accum = accum.trim(); string = string.trim(); }
    if (/\bnonumbers\b/.test(config)) { accum = accum.replace(/\d/g, ""); string = string.replace(/\d/g, ""); }
    if (/\bclip\b/.test(config)) ok = compareClipped(string, accum);
    else if (/\bjoin\b/.test(config)) ok = compareJoined(string, accum);
    else if (clip > -1) ok = string.slice(0, clip) == accum.slice(0, clip);
    else ok = string == accum;
    if (!ok)
      console.log("mismatch at " + this.pos + ". got:\n" + accum + "\nexpected:\n" + string);
  },
  missingErr: function() {
    console.log("expected error not raised at " + this.pos);
  },
  compareErr: function(err, string) {
    if (err.toString() != string)
      console.log("wrong error raised at " + this.pos + ": " + err.toString());
  },
  pos: null,
  console: console
};

function report(err) {
  var msg = err.toString();
  if (/^\[object/.test(msg) && err.message) msg = err.message;
  console.log("error raised (" + _console.pos + "): " + msg, err.stack);
}

require("canvas/lib/context2d").prototype.drawImage = function() {};

// Gruesome kludgery to make the node chapter tests run

var fakeFS = {};
for (var prop in fs) fakeFS[prop] = function() {
  var lastArg = arguments[arguments.length - 1];
  if (lastArg && lastArg.call) lastArg(null, "hi");
  return "ok";
};

var fakeHTTP = {
  request: require("http").request,
  createServer: function() { return {listen: Math.min}; }
};

function fakeRequire(str) {
  if (str == "./garble") return function(string) {
    return string.split("").map(function(ch) {
      return String.fromCharCode(ch.charCodeAt(0) + 5);
    }).join("");
  };
  if (str == "./router") return require("../code/skillsharing/router");
  if (str == "ecstatic") return Math.min;
  if (str == "fs") return fakeFS;
  if (str == "http") return fakeHTTP;

  return require(str);
}

var i = 0, boxes = Object.keys(sandboxes).map(function(k) { return sandboxes[k]; });;
function nextSandbox() {
  if (i == boxes.length) return;
  var sandbox = boxes[i];
  i++;
  if (chapNum < 12 || chapNum >= 20) { // Language-only
    try {
      (new Function("console, require, module", baseCode + sandbox.code))(_console, chapNum >= 20 && fakeRequire, {});
      nextSandbox();
    } catch(e) {
      report(e);
    }
  } else {
    let {JSDOM} = require("jsdom")
    new JSDOM({
      url: "http://eloquentjavascript.net/" + file + "#" + i,
      html: sandbox.html || "<!doctype html><body></body>",
      src: [baseCode],
      done: function(err, window) {
        if (err) report(err[0]);
        window.console = _console;
        window.Element.prototype.innerText = "abc";
        try {
          window.run(sandbox.code, file + "#" + i);
        } catch (e) {
          report(e);
        }
        nextSandbox();
      }
    });
  }
}
nextSandbox();
