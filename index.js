var SerialPort = require('serialport').SerialPort;
var Parsers = require('serialport').parsers;
var Pdu = require('./pdu');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

/**
 * Hayes command structure
 */
function HayesCommand(hayesCommand, callback) {
  "use strict";
  this.cmd = hayesCommand;
  this.response = null;
  this.sent = false;
  this.callback = callback;
  this.waitCommand = null; //Specifies a string to wait for. Waits for standart responses
  this.toString = function () {
    return this.cmd + '\r';
  };
  this.doCallback = function (response) {
    this.response = response;
    if (typeof this.callback === 'function') {
      this.callback(response);
    }
  };
}
/**
 * Returns true if the string is in GSM 7-bit alphabet
 * @param text string to check
 * @return boolean
 */
function isGSMAlphabet(text) {
  "use strict";
  var regexp = new RegExp("^[A-Za-z0-9 \\r\\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!\"#$%&'()*+,\\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\\\\\[~\\]|€]*$");
  return regexp.test(text);
}
/**
 * Constructor for the modem
 * Possible options:
 *  port
 *  notify_port
 *  debug
 *  auto_hangup
 *
 * Extends EventEmitter. Events:
 *  message - new SMS has arrived
 *  report - SMS status report has arrived
 *  USSD - USSD has arrived
 *  disconnect - modem is disconnected
 */
function Modem(opts) {
  "use strict";
  // Call the super constructor.
  EventEmitter.call(this);

  this.ports = [];
  if (undefined !== opts.port) {
    this.ports.push(opts.port);
  }
  if (undefined !== opts.notify_port) {
    this.ports.push(opts.notify_port);
  }
  if (undefined !== opts.ports) {
    for (var i=0; i<opts.ports.length; ++i) {
      this.ports.push(opts.ports[i]);
    }
  }

  if (0 === this.ports.length) {
    console.error('ports are undefined');
    return null;
  }
  this.portErrors = 0;
  this.portConnected = 0;

  this.serialPorts = [];
  this.buffers = [];
  this.bufferCursors = [];
  this.dataPort = null;

  if (undefined !== opts.debug) {
    this.debug = opts.debug;
  }
  // Auto hang up calls
  this.autoHangup = opts.auto_hangup || false;

  this.commandsStack = [];
  
  this.textMode = false;
  this.echoMode = false;

  this.notifyReconnectRetries = 0;
  this.ussdTimeout = opts.ussdTimeout || 15000;
}
util.inherits(Modem, EventEmitter);
Modem.prototype.isGSMAlphabet = isGSMAlphabet;
/**
 * Connects to modem's serial port
 */
Modem.prototype.connect = function (cb) {
  "use strict";
  var i = 0;
  for (i; i < this.ports.length; ++i) {
    var port = this.ports[i];
    this.connectPort(port, cb);
  }
};
/**
 * Connect to the port
 */
Modem.prototype.connectPort = function (port, cb) {
  var serialPort = new SerialPort(port, {
    baudrate: 19200
  });

  var commandTimeout = null;

  serialPort.on('open', function () {
    serialPort.write('AT\r\n');
    commandTimeout = setTimeout(function () {
      this.onPortConnected(serialPort, 0, cb);
    }.bind(this), 1000);
  }.bind(this));

  serialPort.once('data', function (data) {
    if (data.toString().indexOf('OK') !== -1) {
      clearTimeout(commandTimeout);
      this.onPortConnected(serialPort, 1, cb);
    }
  }.bind(this));

  serialPort.on('error', function (err) {
    console.error('Port connect error: %s', err.message);
    if (null !== commandTimeout) {
      clearTimeout(commandTimeout);
    }
    this.onPortConnected(serialPort, -1, cb);
  }.bind(this));
};
/**
 * Callback for port connect or error. Data modes:
 *   0 - notification
 *   1 - data
 *  -1 - error
 */
Modem.prototype.onPortConnected = function(port, dataMode, cb) {
  if (dataMode === -1) {
    ++this.portErrors;
  } else {
    ++this.portConnected;
    this.serialPorts.push (port);

    port.removeAllListeners('error');
    port.on('error', this.serialPortError.bind(this));
    port.on('close', this.serialPortClosed.bind(this));

    var buf = new Buffer(1024);
    var cursor = 0;
    this.buffers.push(buf);
    this.bufferCursors.push(cursor);

    port.on('data', this.onData.bind(this, buf, cursor));
    if (1 === dataMode) {
      this.dataPort = port;
    }
  }

  if (this.portErrors + this.portConnected === this.ports.length) {
    if (null === this.dataPort) {
      this.emit('error', new Error('NOT CONNECTED'));
    } else {
      this.configureModem(function () {
        cb();
      });      
    }
  }
};

Modem.prototype.serialPortError = function(err) {
  console.error('Serial port %s error: %s (%d)', port, err.message, err.code);
  this.emit('error', err);
};

Modem.prototype.serialPortClosed = function(err) {
  console.log('Port was closed!');
  this.emit('disconnect');
};

/**
 * Pushes command to commands stack
 */
Modem.prototype.sendCommand = function (cmd, cb, waitFor) {
  "use strict";
  var scmd = new HayesCommand(cmd, cb);
  if (waitFor !== undefined) {
    scmd.waitCommand = waitFor;
  }
  this.commandsStack.push(scmd);
  if (this.commandsStack.length === 1) { //no previous commands are waiting in the stack, go ahead!
    this.sendNext();
  }
};
/**
 * Sends next command from stack
 */
Modem.prototype.sendNext = function () {
  "use strict";
  if (this.commandsStack.length === 0) {
    return;
  }
  var cmd = this.commandsStack[0];
  if (cmd && !cmd.sent) {
    this.__writeToSerial(cmd);
  }
};
/**
 * Writes command to serial port
 */
Modem.prototype.__writeToSerial = function (cmd) {
  "use strict";
  cmd.sent = true;
  this.willReceiveEcho = true;
  if (this.debug) {
    console.log(' ----->', cmd.toString());
  }
  this.dataPort.write(cmd.toString(), function (err) {
    if (err) {
      console.error('Error sending command:', cmd.toString(), 'error:', err);
      this.sendNext();
    }
  }.bind(this));
};
/**
 * 
 */
Modem.prototype.onData = function (buffer, cursor, data) {
  "use strict";
  if (this.debug) {
    console.log(' <-----', data.toString());
  }
  if (cursor + data.length > buffer.length) { //Buffer overflow
    console.error('Data buffer overflow');
    cursor = 0;
  }
  data.copy(buffer, cursor);
  cursor += data.length;
  var resp = buffer.slice(0, cursor - 1).toString().trim();
  var arr = resp.split('\r\n');

  if (arr.length > 0) {
    //TODO: handle notification lines here
    var i, arrLength = arr.length, hadNotification = false;
    for (i = arrLength - 1; i >= 0; --i) {
      if (this.handleNotification(arr[i])) {
        arr.splice(i, 1);
        --arrLength;
        hadNotification = true;
      }
    }
    if (hadNotification) {
      if (arrLength > 0) {
        var b = new Buffer(arr.join('\r\n'));
        b.copy(buffer, 0);
        cursor = b.length;
      } else {
        cursor = 0;
        return;
      }
    }
    var lastLine = (arr[arrLength - 1]).trim();

    if (this.commandsStack.length > 0) {
      var cmd = this.commandsStack[0];
      var b_Finished = false;

      if (-1 !== lastLine.indexOf('ERROR') || -1 !== lastLine.indexOf('NOT SUPPORT')) {
        b_Finished = true;
      } else if (cmd.waitCommand !== null) {
        if (-1 !== resp.indexOf(cmd.waitCommand)) {
          b_Finished = true;
        }
      } else if (-1 !== lastLine.indexOf('OK')) {
        b_Finished = true;
      }
      if (b_Finished) {
        this.commandsStack.splice(0, 1);
        if (this.echoMode) {
          arr.splice(0, 1);
        }
        cmd.doCallback(resp);
        cursor = 0;
        this.sendNext();
      }
    } else {
      console.log('Unhandled command: %s', resp);
    }
  } 
};
/**
 *
 */
Modem.prototype.handleNotification = function(line) {
  var handled = false;

  if (line.substr(0, 5) === '+CMTI') {
    match = line.match(/\+CMTI:\s*"?([A-Za-z0-9]+)"?,(\d+)/);
    if (null !== match && match.length > 2) {
      smsId = parseInt(match[2], 10);
      this.getSMS(smsId, function (err, msg) {
        if (err === undefined) {
          this.deleteSMS(smsId, function (err) {
            if (err) {
              console.error('Unable to delete incoming message!!', err.message);
            }
          });
          this.emit('message', msg);
        }
      }.bind(this));
    }
    handled = true;
  } else if (line.substr(0, 5) === '+CDSI') {
    match = line.match(/\+CDSI:\s*"?([A-Za-z0-9]+)"?,(\d+)/);
    if (null !== match && match.length > 2) {
      smsId = parseInt(match[2], 10);
      this.getSMS(smsId, function (err, msg) {
        if (err === undefined) {
          this.deleteSMS(smsId, function (err) {
            if (err) {
              console.error('Unable to delete incoming report!!', err.message);
            }
          });
          this.emit('report', msg);
        }
      }.bind(this));
    }
    handled = true;
  } else if (line.substr(0, 5) === '+CUSD') {
    match = line.match(/\+CUSD:\s*(\d),"?([0-9A-F]+)"?,(\d*)/);
    if (match !== null && match.length === 4) {
      this.emit('USSD', parseInt(match[1], 10), match[2], parseInt(match[3], 10));
    }
    handled = true;
  } else if (line.substr(0, 4) === 'RING') {
    if (this.autoHangup) {
      this.sendCommand('ATH');
    }
    handled = true;
  }
  return handled;
};
/**
 * Configures modem
 */
Modem.prototype.configureModem = function (cb) {
  "use strict";
  this.setEchoMode(false);
  this.setTextMode(false);
  this.disableStatusNotifications();
  this.sendCommand('AT+CNMI=2,1,0,2,0', function (data) {
    cb();
  });
};
/**
 * Disables ^RSSI status notifications
 */
Modem.prototype.disableStatusNotifications = function () {
  "use strict";
  this.sendCommand('AT^CURC?', function (data) {
    if (data.indexOf('COMMAND NOT SUPPORT') === -1) {
      this.sendCommand('AT^CURC=0');
    }
  }.bind(this));
};
/**
 * Sets modem's text mode
 * @param textMode boolean
 */
Modem.prototype.setTextMode = function (textMode, cb) {
  "use strict";
  this.sendCommand('AT+CMGF=' + (textMode === true ? '1' : '0'), function (data) {
    if (-1 !== data.indexOf('OK')) {
      this.textMode = textMode;
    }
    if (typeof cb === 'function') {
      cb(undefined, this.textMode);
    }
  }.bind(this));
};
/**
 * Sets echo mode to on/off
 */
Modem.prototype.setEchoMode = function (state, cb) {
  "use strict";
  this.sendCommand('ATE' + (state ? '1' : '0'), function (data) {
    if (-1 !== data.indexOf('OK')) {
      this.echoMode = state;
    }
    if (typeof cb === 'function') {
      cb(undefined, this.echoMode);
    }
  }.bind(this));
};
/**
 * Gets current modem's SMS Center
 */
Modem.prototype.getSMSCenter = function (cb) {
  "use strict";
  this.sendCommand('AT+CSCA?', function (data) {
    if (typeof cb === 'function') {
      var match = data.match(/\+CSCA:\s*"?([0-9]*)"?,(\d*)/);
      if (match) {
        cb(undefined, match[1]);
      } else {
        cb(new Error('NOT SUPPORTED'));
      }
    }
  });
};
/**
 * Receives all short messages stored in the modem
 */
Modem.prototype.getAllSMS = function (cb) {
  "use strict";
  // this.sendCommand('AT+CPMS="SM"');
  this.sendCommand('AT+CMGL=' + (this.textMode ? '"ALL"' : 4), function (data) {
    if (typeof cb === 'function') {
      if (data.indexOf('OK') === -1) {
        cb(new Error(data));
        return;
      }
      var ret = {};
      var arr = data.split('\r\n');
      var i, msgStruct, index, match;
      for (i = 0; i < arr.length; ++i) {
        if (!this.textMode) {
          match = arr[i].match(/\+CMGL:\s*(\d+),(\d+),(\w*),(\d+)/);
          if (match !== null && match.length > 4) {
            msgStruct = Pdu.parse(arr[++i]);
            index = match[1];
            msgStruct.status = parseInt(match[2], 10);
            msgStruct.alpha = match[3];
            msgStruct.length = parseInt(match[4], 10);
            ret[index] = msgStruct;
          }
        } else {
          //TODO: handle text mode
          console.log('Text mode is not supported right now', arr[i]);
        }
      }
      cb(undefined, ret);
    }
  });
};
/**
 * Requests SMS by id
 * @param id int of the SMS to get
 * @param cb function to callback. Function should receive dictionary containing the parsed pdu message
 */
Modem.prototype.getSMS = function (id, cb) {
  "use strict";
  this.sendCommand('AT+CMGR=' + id, function (data) {
    if (-1 === data.indexOf('OK')) {
      cb(new Error(data));
      return;
    }
    var arr = data.split('\r\n');
    var i, match, msgStruct;
    for (i = 0; i < arr.length; ++i) {
      match = arr[i].match(/\+CMGR:\s+(\d*),(\w*),(\d+)/);
      if (null !== match && match.length > 3) {
        msgStruct = Pdu.parse(arr[++i]);
        cb(undefined, msgStruct);
        break;
      }
    }
  });
};

/**
 * Queue to send parts of the message
 */
function PartsSendQueue(modem, parts, cb) {
  var currentPart = 0;
  var references = [];

  this.sendNext = function () {
    if (currentPart >= parts.length) {
      if (typeof cb === 'function') {
        cb(undefined, references);
      }
    } else {
      modem.sendCommand('AT+CMGS=' + parts[currentPart].tpdu_length, undefined, '>');
      modem.sendCommand(parts[currentPart].smsc_tpdu + String.fromCharCode(26), this.onSend.bind(this));
      ++currentPart;
    }
  };

  this.onSend = function (data) {
    var match = data.match(/\+CMGS:\s*(\d+)/);
    if (match !== null && match.length > 1) {
      references.push(parseInt(match[1], 10));
      this.sendNext();
    } else {
      if (typeof cb === 'function') {
        cb(new Error(data));
      }
    }
  };
}

/**
 * Sends SMS to the recepient.
 * @param message dictionary with possible keys:
 *  receiver - MSISDN of the recepient (required)
 *  text - text to send (required)
 *  receiver_type - 0x81 for local, 0x91 for international format
 *  encoding - 7bit or 16bit is supported. If not specified will be detected automatically
 *  request_status - if the modem should request delivery report
 *  smsc - SMS center to use (MSISDN) (default:use modem's default SMSC)
 *  smsc_type - SMS center type (0x81 for international and local, 0x91 for international format only) (default:0x81)
 */
Modem.prototype.sendSMS = function (message, cb) {
  "use strict";
  if (message.receiver === undefined || message.text === undefined) {
    cb(new Error('Either receiver or text is not specified'));
    return;
  }

  if (!this.textMode) {
    var opts = message;
    if (opts.receiver_type === undefined) {
      opts.receiver_type = 0x91;
    }
    if (opts.encoding === undefined) {
      opts.encoding = isGSMAlphabet(opts.text) ? '7bit' : '16bit';
    }

    var encoded = Pdu.generate(opts);
    var queue = new PartsSendQueue(this, encoded, cb);
    queue.sendNext();
  }
  //TODO: make textmode
};

Modem.prototype.deleteAllSMS = function (cb) {
  this.sendCommand('AT+CMGD=1,4', function (data) {
    if (typeof cb === 'function') {
      if (-1 === data.indexOf('OK')) {
        cb(new Error(data));
      } else {
        cb(undefined);
      }
    }
  });
};
/**
 * Deletes message by id
 */
Modem.prototype.deleteSMS = function (smsId, cb) {
  this.sendCommand('AT+CMGD=' + smsId, function (data) {
    if (typeof cb === 'function') {
      if (-1 === data.indexOf('OK')) {
        cb(new Error(data));
      } else {
        cb(undefined);
      }
    }
  });
};

/**
 * Requests custom USSD
 */
Modem.prototype.getUSSD = function (ussd, cb) {
  var encoded = Pdu.ussdEncode(ussd);
  this.sendCommand('AT+CUSD=1,"' + encoded + '",15', function (data) {
    if (data.indexOf('OK') !== -1) {
      var processed = false;
      var USSDHandler = function (status, data, dcs) {
        processed = true;
        if (status === 1) { //cancel USSD session
          this.sendCommand('AT+CUSD=2');
        }
        var encoding = Pdu.detectEncoding(dcs);
        var text = '';
        if (encoding === '16bit') {
          text = Pdu.decode16Bit(data);
        } else if (encoding === '7bit') {
          text = Pdu.decode7Bit(data);
        } else {
          cb(new Error('Unknown encoding'));
          return;
        }
        cb(undefined, text);
      }.bind(this);

      this.once('USSD', USSDHandler);
      setTimeout(function () {
        if (!processed) {
          this.removeListener('USSD', USSDHandler);
          cb(new Error('timeout'));
        }
      }.bind(this), this.ussdTimeout);
    }
  }.bind(this));
};
/**
 * Returns modem's IMSI
 */
Modem.prototype.getIMSI = function (cb) {
  "use strict";
  this.sendCommand('AT+CIMI', function (data) {
    if (typeof cb === 'function') {
      var match = data.match(/(\d{10,})\r\n/);
      if (null !== match && match.length === 2) {
        cb(undefined, match[1]);
      } else {
        cb(new Error('NOT SUPPORTED'));
      }
    }
  });
};
/**
 * Returns modem's IMEI
 */
Modem.prototype.getIMEI = function (cb) {
  "use strict";
  this.sendCommand('AT+CGSN', function (data) {
    if (typeof cb === 'function') {
      var match = data.match(/(\d{10,})\r\n/);
      if (null !== match && match.length === 2) {
        cb(undefined, match[1]);
      } else {
        cb(new Error('NOT SUPPORTED'));
      }
    }
  });
};
/**
 * Returns modem's model
 */
Modem.prototype.getModel = function (cb) {
  "use strict";
  this.sendCommand('AT+CGMM', function (data) {
    if (typeof cb === 'function') {
      if (data.indexOf('OK') === -1) {
        cb(new Error(data));
      } else {
        cb(undefined, data.split('\r\n')[0]);
      }
    }
  });
};
/**
 * Requests operator name or code
 * @param text boolean return operator name if true, code otherwise
 * @param cb to call on completion
 */
Modem.prototype.getOperator = function (text, cb) {
  "use strict";
  this.sendCommand('AT+COPS=3,' + (text ? '0' : '2') + ';+COPS?', function (operator) {
    var match = operator.match(/\+COPS: (\d*),(\d*),"?([\w \-]+)"?,(\d*)/);
    if (typeof cb === 'function') {
      if (null !== match && 4 < match.length) {
        cb(undefined, match[3]);
      } else {
        cb(new Error('NOT SUPPORTED'));
      }
    }
  }.bind(this));
};
/**
 * Requests current signal strength
 * @param cb function to call on completion. Returns dictionary with keys db and condition
 */
Modem.prototype.getSignalStrength = function (cb) {
  "use strict";
  this.sendCommand('AT+CSQ', function (data) {
    if (typeof cb === 'function') {
      var match = data.match(/\+CSQ: (\d+),(\d*)/);
      if (null !== match && 2 < match.length) {
        var scale = parseInt(match[1], 10);
        if (scale === 99) {
          cb(undefined, {
            db: 0,
            condition: 'unknown'
          });
        } else {
          var db = -113 + scale * 2, condition;
          if (db < -95) {
            condition = 'marginal';
          } else if (db < -85) {
            condition = 'workable';
          } else if (db < -75) {
            condition = 'good';
          } else {
            condition = 'excellent';
          }
          cb(undefined, {
            db: db,
            condition: condition
          });
        }
      } else {
        cb(new Error('NOT SUPPORTED'));
      }
    }
  });
};


module.exports = Modem;
