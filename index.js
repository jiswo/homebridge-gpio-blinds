var _ = require('underscore');
var rpio = require('rpio');
//var gpio = require('rpi-gpio');
var wpi = require('node-wiring-pi');

var Service, Characteristic, HomebridgeAPI;

const STATE_DECREASING = 0;
const STATE_INCREASING = 1;
const STATE_STOPPED = 2;

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    HomebridgeAPI = homebridge;
    homebridge.registerAccessory('homebridge-gpio-blinds', 'Blinds', BlindsAccessory);
};

function BlindsAccessory(log, config) {
    _.defaults(config, { durationOffset: 0, activeLow: true, reedSwitchActiveLow: true });

    this.services = [];

    this.log = log;
    this.name = config['name'];
    this.pinUp = config['pinUp'];
    this.pinDown = config['pinDown'];
    this.durationUp = config['durationUp'];
    this.durationDown = config['durationDown'];
    this.durationOffset = config['durationOffset'];
    this.pinClosed = config['pinClosed'];
    this.pinOpen = config['pinOpen'];
    this.initialState = config['activeLow'] ? rpio.HIGH : rpio.LOW;
    this.activeState = config['activeLow'] ? rpio.LOW : rpio.HIGH;
    this.reedSwitchActiveState = config['reedSwitchActiveLow'] ? rpio.LOW : rpio.HIGH;
    this.externalButtonPin = config['externalButtonPin'];

    this.cacheDirectory = HomebridgeAPI.user.persistPath();
    this.storage = require('node-persist');
    this.storage.initSync({ dir: this.cacheDirectory, forgiveParseErrors: true });

    var cachedCurrentPosition = this.storage.getItemSync(this.name);
    if (cachedCurrentPosition === undefined || cachedCurrentPosition === false) {
        this.currentPosition = 0; // down by default
    } else {
        this.currentPosition = cachedCurrentPosition;
    }

    this.targetPosition = this.currentPosition;
    this.positionState = STATE_STOPPED; // stopped by default

    this.service = new Service.WindowCovering(this.name);

    this.infoService = new Service.AccessoryInformation();
    this.infoService
        .setCharacteristic(Characteristic.Manufacturer, 'Radoslaw Sporny')
        .setCharacteristic(Characteristic.Model, 'RaspberryPi GPIO Blinds')
        .setCharacteristic(Characteristic.SerialNumber, 'Version 1.1.2');

    this.addService(this.infoService);

    this.finalBlindsStateTimeout;
    this.togglePinTimeout;
    this.intervalUp = this.durationUp / 100;
    this.intervalDown = this.durationDown / 100;
    this.currentPositionInterval;

    // use gpio pin numbering
    rpio.init({
        mapping: 'gpio'
    });

    rpio.open(this.pinUp, rpio.OUTPUT, this.initialState);
    rpio.open(this.pinDown, rpio.OUTPUT, this.initialState);

    if (this.pinClosed)
        rpio.open(this.pinClosed, rpio.INPUT, rpio.PULL_UP);

    if (this.pinOpen)
        rpio.open(this.pinOpen, rpio.INPUT, rpio.PULL_UP);

    this.service
        .getCharacteristic(Characteristic.CurrentPosition)
        .on('get', this.getCurrentPosition.bind(this));

    this.service
        .getCharacteristic(Characteristic.PositionState)
        .on('get', this.getPositionState.bind(this));

    this.service
        .getCharacteristic(Characteristic.TargetPosition)
        .on('get', this.getTargetPosition.bind(this))
        .on('set', this.setTargetPosition.bind(this));

    this.addService(this.service);

    if (this.externalButtonPin) {
        wpi.setup('wpi');
        this.device = new DigitalInput(this, log, this.externalButtonPin);    
    }
}

BlindsAccessory.prototype.getPositionState = function (callback) {
    this.log("Position state: %s", this.positionState);
    callback(null, this.positionState);
};

BlindsAccessory.prototype.getCurrentPosition = function (callback) {
    this.log("Current position: %s", this.currentPosition);
    callback(null, this.currentPosition);
};

BlindsAccessory.prototype.getTargetPosition = function (callback) {
    var updatedPosition;
    if (this.openCloseSensorMalfunction()) {
        this.log("Open and close reed switches are active, setting to 50");
        updatedPosition = 50;
    } else if (this.closedAndOutOfSync()) {
        this.log("Current position is out of sync, setting to 0");
        updatedPosition = 0;
    } else if (this.openAndOutOfSync()) {
        this.log("Current position is out of sync, setting to 100");
        updatedPosition = 100;
    } else if (this.partiallyOpenAndOutOfSync()) {
        this.log("Current position is out of sync, setting to 50");
        updatedPosition = 50;
    }
    if (updatedPosition !== undefined) {
        this.currentPosition = updatedPosition;
        this.targetPosition = updatedPosition;
        this.storage.setItemSync(this.name, updatedPosition);
    }
    this.log("Target position: %s", this.targetPosition);
    callback(null, this.targetPosition);
};

BlindsAccessory.prototype.setTargetPosition = function (position, callback) {
    this.log("Setting target position to %s", position);
    this.targetPosition = position;
    var moveUp = this.targetPosition >= this.currentPosition;
    var duration;

    if (this.positionState !== STATE_STOPPED) {
        this.log("Blind is moving, current position %s", this.currentPosition);
        if (this.oppositeDirection(moveUp)) {
            this.log('Stopping the blind because of opposite direction');
            rpio.write(moveUp ? this.pinDown : this.pinUp, this.initialState);
        }
        clearInterval(this.currentPositionInterval);
        clearTimeout(this.finalBlindsStateTimeout);
        clearTimeout(this.togglePinTimeout);
    }

    if (this.currentPosition === position) {
        this.log('Current position already matches target position. There is nothing to do.');
        callback();
        return true;
    }

    if (moveUp) {
        duration = Math.round((this.targetPosition - this.currentPosition) / 100 * this.durationUp);
        this.currentPositionInterval = setInterval(this.setCurrentPosition.bind(this, moveUp), this.intervalUp);
    } else {
        duration = Math.round((this.currentPosition - this.targetPosition) / 100 * this.durationDown);
        this.currentPositionInterval = setInterval(this.setCurrentPosition.bind(this, moveUp), this.intervalDown);
    }

    this.log((moveUp ? 'Moving up' : 'Moving down') + ". Duration: %s ms.", duration);

    this.service.setCharacteristic(Characteristic.PositionState, moveUp ? STATE_INCREASING : STATE_DECREASING);
    this.positionState = moveUp ? STATE_INCREASING : STATE_DECREASING;

    this.finalBlindsStateTimeout = setTimeout(this.setFinalBlindsState.bind(this), duration);
    this.togglePin(moveUp ? this.pinUp : this.pinDown, duration);

    callback();
    return true;
};

BlindsAccessory.prototype.togglePin = function (pin, duration) {
    if (rpio.read(pin) !== this.activeState) rpio.write(pin, this.activeState);
    if (this.durationOffset && (this.targetPosition === 0 || this.targetPosition === 100)) this.duration += this.durationOffset;
    this.togglePinTimeout = setTimeout(function () {
        rpio.write(pin, this.initialState);
    }.bind(this), parseInt(duration));
};

BlindsAccessory.prototype.setFinalBlindsState = function () {
    clearInterval(this.currentPositionInterval);
    this.positionState = STATE_STOPPED;
    this.service.setCharacteristic(Characteristic.PositionState, STATE_STOPPED);
    this.service.setCharacteristic(Characteristic.CurrentPosition, this.targetPosition);
    this.currentPosition = this.targetPosition;
    this.storage.setItemSync(this.name, this.currentPosition);
    this.log("Successfully moved to target position: %s", this.targetPosition);
};

BlindsAccessory.prototype.setCurrentPosition = function (moveUp) {
    if (moveUp) {
        this.currentPosition++;
    } else {
        this.currentPosition--;
    }
    this.storage.setItemSync(this.name, this.currentPosition);
};

BlindsAccessory.prototype.closedAndOutOfSync = function () {
    return this.currentPosition !== 0 && this.pinClosed && rpio.read(this.pinClosed) === this.reedSwitchActiveState;
};

BlindsAccessory.prototype.openAndOutOfSync = function () {
    return this.currentPosition !== 100 && this.pinOpen && rpio.read(this.pinOpen) === this.reedSwitchActiveState;
};

BlindsAccessory.prototype.partiallyOpenAndOutOfSync = function () {
    return this.currentPosition === 0 && this.pinClosed && rpio.read(this.pinClosed) !== this.reedSwitchActiveState ||
        this.currentPosition === 100 && this.pinOpen && rpio.read(this.pinOpen) !== this.reedSwitchActiveState;
};

BlindsAccessory.prototype.openCloseSensorMalfunction = function () {
    return this.pinClosed && this.pinOpen &&
        rpio.read(this.pinClosed) === this.reedSwitchActiveState &&
        rpio.read(this.pinOpen) === this.reedSwitchActiveState;
};

BlindsAccessory.prototype.oppositeDirection = function (moveUp) {
    return this.positionState === STATE_INCREASING && !moveUp || this.positionState === STATE_DECREASING && moveUp;
};

BlindsAccessory.prototype.getServices = function () {
    return this.services;
};
BlindsAccessory.prototype.addService = function (service) {
    this.services.push(service);
};

function DigitalInput(accesory, log, pin) {
    this.log = log;
    this.pin = pin;
    this.toggle = true;
    this.postpone = 100;
    this.pullUp = true;

    this.INPUT_ACTIVE = wpi.HIGH;
    this.INPUT_INACTIVE = wpi.LOW;

    this.ON_STATE = 1;
    this.OFF_STATE = 0;

    var service = new Service['ContactSensor']('Switch 1');

    this.stateCharac = service.getCharacteristic(Characteristic.ContactSensorState);
    this.stateCharac.on('get', this.getState.bind(this));

    wpi.pinMode(this.pin, wpi.INPUT);
    wpi.pullUpDnControl(this.pin, this.pullUp ? wpi.PUD_UP : wpi.PUD_OFF);

    if (this.toggle)
        wpi.wiringPiISR(this.pin, wpi.INT_EDGE_FALLING, this.toggleState.bind(this)); // Falling because pin are pulled-up (so triggers when became low)
    else
        wpi.wiringPiISR(this.pin, wpi.INT_EDGE_BOTH, this.stateChange.bind(this));

    accesory.addService(service);
}

DigitalInput.prototype = {
    stateChange: function (delta) {
        if (this.postponeId === null) {
            this.postponeId = setTimeout(function () {
                this.postponeId = null;
                var state = wpi.digitalRead(this.pin);
                this.stateCharac.updateValue(state === this.INPUT_ACTIVE ? this.ON_STATE : this.OFF_STATE);
                if (this.occupancy) {
                    this.occupancyUpdate(state);
                }
            }.bind(this), this.postpone);
        }
    },

    toggleState: function (delta) {
        if (this.postponeId === null) {
            this.postponeId = setTimeout(function () {
                this.postponeId = null;
                var state = wpi.digitalRead(this.pin);
                this.stateCharac.updateValue(this.stateCharac.value === this.ON_STATE ? this.OFF_STATE : this.ON_STATE);
            }.bind(this), this.postpone);
        }
    },

    getState: function (callback) {
        var state = wpi.digitalRead(this.pin);
        callback(null, state === this.INPUT_ACTIVE ? this.ON_STATE : this.OFF_STATE);
    },

    occupancyUpdate: function (state) {
        var characteristic = this.occupancy.getCharacteristic(Characteristic.OccupancyDetected);
        if (state === this.INPUT_ACTIVE) {
            characteristic.updateValue(Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
            if (this.occupancyTimeoutID !== null) {
                clearTimeout(this.occupancyTimeoutID);
                this.occupancyTimeoutID = null;
            }
        } else if (characteristic.value === Characteristic.OccupancyDetected.OCCUPANCY_DETECTED) { // On motion ends
            this.occupancyTimeoutID = setTimeout(function () {
                characteristic.updateValue(Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
                this.occupancyTimeoutID = null;
            }.bind(this), this.occupancyTimeout);
        }
    }
};