"use strict";

import fetch from 'node-fetch';
import process from 'node:process';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import convert from 'color-convert';

let Service;
let Characteristic;

const PACKET_TYPE_AUTH = 1;
const PACKET_TYPE_SYNC = 4;
const PACKET_TYPE_STATUS = 7;
const PACKET_TYPE_STATUS_SYNC = 8;
const PACKET_TYPE_CONNECTED = 10;
const PACKET_TYPE_PING = 13;

const PACKET_SUBTYPE_SET_STATUS = 0xd0;
const PACKET_SUBTYPE_SET_BRIGHTNESS = 0xd2;
const PACKET_SUBTYPE_SET_COLOR_TEMP = 0xe2;
const PACKET_SUBTYPE_SET_STATE = 0xf0;
const PACKET_SUBTYPE_GET_STATUS = 0xdb;
const PACKET_SUBTYPE_GET_STATUS_PAGINATED = 0x52;

const PING_BUFFER = Buffer.alloc(0);

const DEVICES_WITH_BRIGHTNESS = [1,5,6,7,8,9,10,11,13,14,15,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,48,49,55,56,80,81,82,83,85,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,156,158,159,160,161,162,163,164,165];
const DEVICES_WITH_COLOR_TEMP = [5,6,7,8,10,11,14,15,19,20,21,22,23,25,26,28,29,30,31,32,33,34,35,80,82,83,85,129,130,131,132,133,135,136,137,138,139,140,141,142,143,144,145,146,147,153,154,156,158,159,160,161,162,163,164,165];
const DEVICES_WITH_RGB = [6,7,8,21,22,23,30,31,32,33,34,35,131,132,133,137,138,139,140,141,142,143,146,147,153,154,156,158,159,160,161,162,163,164,165];

class CyncPlatform {

    constructor(log, config, api) {
        // store restored cached accessories here
        this.accessories = [];
        this.lights = [];
        this.log = log;
        this.config = config;
        this.api = api;
        this.seq = 1;
        this.connectionTime = 0;
        this.packetQueue = [];

        this.api.on('didFinishLaunching', () => {
            this.connect();
            setInterval(() => this.ping(), 180000);

            this.authenticate().then(() => {
                this.registerLights();
            });
        });
    }

    async authenticate() {
        // first, check the access_token
        this.log.info("Logging into Cync...");

        let payload = { refresh_token: this.config.refreshToken };
        let token = await fetch("https://api.gelighting.com/v2/user/token/refresh", {
            method: 'post',
            body: JSON.stringify(payload),
            headers: {'Content-Type': 'application/json'}
        });

        const data = await token.json();
        this.log.info(`Cync login response: ${JSON.stringify(data)}`);
        this.accessToken = data.access_token;
        this.log.info(`Access token: ${this.accessToken}`);
        if (!this.accessToken) {
            this.log.error("Unable to authenticate with Cync servers.  Please verify you have a valid refresh token.");
        }
    }

    connect() {
        if (!this.connected) {
            this.log.info("Connecting to Cync servers...");
            this.socket = net.connect(23778, "cm.gelighting.com");
            this.socket.on('readable', () => this.readPackets());
            this.socket.on('end', () => this.disconnect());

            const data = Buffer.alloc(this.config.authorize.length + 10);
            data.writeUInt8(0x03);
            data.writeUInt32BE(this.config.userID, 1);
            data.writeUInt8(this.config.authorize.length, 6);
            data.write(this.config.authorize, 7, this.config.authorize.length, 'ascii');
            data.writeUInt8(0xb4, this.config.authorize.length + 9);
            this.socket.write(this.createPacket(PACKET_TYPE_AUTH, data));
        }
    }

    disconnect() {
        this.log.info(`Connection to Cync has closed.`);
        this.connected = false;

        // Don't allow reconnects in any less than 10 seconds since the last successful connection
        setTimeout(() => this.connect(), Math.max(10000 - Date.now() + this.connectionTime, 0));
    }

    handleConnect(packet) {
        if (packet.data.readUInt16BE() == 0) {
            this.log.info("Cync server connected.");
            this.flushQueue();
            this.connected = true;
            this.connectionTime = Date.now();
        }
        else {
            this.connected = false;
            this.log.info("Server authentication failed.");
        }
    }

    ping() {
        if (this.connected) {
            this.socket.write(this.createPacket(PACKET_TYPE_PING, PING_BUFFER));
        }
    }

    flushQueue() {
        this.log.info(`Flushing queue of ${this.packetQueue.length} packets.`);
        while(this.packetQueue.length > 0) {
            this.socket.write(this.packetQueue.shift());
        }
    }

    sendPacket(type, data, log = false) {
        const packet = this.createPacket(type, data);
        if (this.connected) {
            if (log)
                this.log.info(`Sending packet: ${packet.toString('hex')}`);

            this.socket.write(packet);
        }
        else {
            if (log)
                this.log.info(`Queueing packet: ${packet.toString('hex')}`);

            // queue the packet
            this.packetQueue.push(packet);
        }
    }

    createPacket(type, data) {
        const packet = Buffer.alloc(data.length + 5);
        packet.writeUInt8((type << 4) | 3);

        if (data.length > 0) {
            packet.writeUInt32BE(data.length, 1);
            data.copy(packet, 5);
        }

        return packet;
    }

    sendRequest(type, switchID, subtype, request, log = false) {
        const data = Buffer.alloc(18 + request.length);
        data.writeUInt32BE(switchID);
        data.writeUInt16BE(this.seq++, 4);
        data.writeUInt8(0x7e, 7);
        data.writeUInt8(0xf8, 12);
        data.writeUInt8(subtype, 13); // status query subtype
        data.writeUInt8(request.length, 14);
        request.copy(data, 18);

        if (log)
            this.log.info(`Sending request: ${data.toString('hex')}`);

        this.sendPacket(type, data, log);
    }

    printPacket(packet) {
        this.log.info(`Got packet: ${packet.type} (${packet.length}) - ${packet.data.toString('hex')}`);
    }

    readPackets() {
        let packet = this.readPacket();
        while (packet) {
            // this.printPacket(packet);
            switch (packet.type) {
                case PACKET_TYPE_AUTH:
                    this.handleConnect(packet);
                    break;
                case PACKET_TYPE_STATUS:
                    this.handleStatus(packet);
                    break;
                case PACKET_TYPE_SYNC:
                    this.handleSync(packet);
                    break;
                case PACKET_TYPE_STATUS_SYNC:
                    this.handleStatusSync(packet);
                    break;
                case PACKET_TYPE_CONNECTED:
                    this.handleConnectedDevices(packet);
                    break;
            }

            packet = this.readPacket();
        }
    }

    readPacket() {
        // First read the header
        const header = this.socket.read(5);
        if (header) {
            // this.log.info(`Header: ${header.toString('hex')}`);
            const type = (header.readUInt8() >>> 4);
            const isResponse = (header.readUInt8() & 8) != 0;
            const length = header.readUInt32BE(1);
            // this.log.info(`Got packet header with type ${type}, header ${header.toString('hex')}, length ${length}, isResponse ${isResponse}`);

            if (length > 0) {
                const data = this.socket.read(length);

                // if (!isResponse)
                //     this.log.info(`Got packet with type ${type}, header ${header.toString('hex')} and body ${data.toString('hex')}`);

                if (data.length == length)
                {
                    return {
                        type: type,
                        length: length,
                        isResponse: isResponse,
                        data: data
                    }
                }
                else {
                    this.log.info("Packet length doesn't match.");
                }
            }
        }

        return null;
    }

    updateConnectedDevice(bulb) {
        bulb.connected = false;

        // Ask the server if each device is connected
        const data = Buffer.alloc(7);
        data.writeUInt32BE(bulb.switchID);
        data.writeUInt16BE(this.seq++, 4);
        this.sendPacket(PACKET_TYPE_CONNECTED, data, true);

        // check again in 5 minutes
        setTimeout(() => { this.updateConnectedDevice(bulb) }, 300000);
    }

    handleConnectedDevices(packet) {
        const switchID = packet.data.readUInt32BE();
        const bulb = this.lightBulbBySwitchID(switchID);
        if (bulb && !bulb.connected) {
            bulb.connected = true;
            setTimeout(() => { this.updateStatus(bulb); });
        }
    }

    updateStatus(bulb) {
        if (bulb.connected) {
            const data = Buffer.alloc(6);
            data.writeUInt16BE(0xffff);
            data.writeUInt8(0x56, 4);
            data.writeUInt8(0x7e, 5);
            this.sendRequest(PACKET_TYPE_STATUS, bulb.switchID, PACKET_SUBTYPE_GET_STATUS_PAGINATED, data, true);
        }
    }

    handleStatus(packet) {
        const switchID = packet.data.readUInt32BE();
        const responseID = packet.data.readUInt16BE(4);

        if (!packet.isResponse) {
            // send a response
            const data = Buffer.alloc(7);
            data.writeUInt32BE(switchID);
            data.writeUInt16BE(responseID, 4);
            this.sendPacket(PACKET_TYPE_STATUS, data, true);
        }

        if (packet.length >= 25) {
            const subtype = packet.data.readUInt8(13);
            let status = packet.data;
            switch (subtype) {
                case PACKET_SUBTYPE_GET_STATUS:
                    const meshID = status.readUInt8(21);
                    const state = status.readUInt8(27) > 0;
                    const brightness = state ? status.readUInt8(28) : 0;

                    const bulb = this.lightBulbByMeshID(meshID);
                    if (bulb) {
                        bulb.updateStatus(state, brightness, bulb.cyncColorTemp, bulb.rgb);
                    }
                case PACKET_SUBTYPE_GET_STATUS_PAGINATED:
                    status = status.subarray(22);
                    while (status.length > 24) {
                        const meshID = status.readUInt8();
                        const state = status.readUInt8(8) > 0;
                        const brightness = state ? status.readUInt8(12) : 0;
                        const colorTemp = status.readUInt8(16);
                        const rgb = [status.readUInt8(20), status.readUInt8(21), status.readUInt8(22)]

                        this.lightBulbByMeshID(meshID)?.updateStatus(state, brightness, colorTemp, rgb);
                        status = status.subarray(24);
                    }
            }
        }
        // this.log.info(`Received status packet of length ${packet.length}: ${packet.data.toString('hex')}`);
    }

    handleSync(packet) {
        // this.log.info(`Got status packet: ${packet.data.toString('hex')}`);
        const switchID = packet.data.readUInt32BE();
        const data = packet.data.subarray(7);

        for (let offset = 0; offset < data.length; offset += 19) {
            const status = data.subarray(offset, offset + 19);
            const meshID = status.readUInt8(3);
            const isOn = status.readUInt8(4) > 0;
            const brightness = isOn ? status.readUInt8(5) : 0;
            const colorTemp = status.readUInt8(6);

            const bulb = this.lightBulbByMeshID(meshID);
            if (bulb) {
                bulb.updateStatus(isOn, brightness, colorTemp, bulb.rgb);
            }
        }
    }

    handleStatusSync(packet) {
        // this.log.info(`Got status sync packet: ${packet.data.toString('hex')}`);
        if (packet.length >= 33) {
            const switchID = packet.data.readUInt32BE();
            const meshID = packet.data.readUInt8(21);
            const isOn = packet.data.readUInt8(27) > 0;
            const brightness = isOn ? packet.data.readUInt8(28) : 0;

            const bulb = this.lightBulbByMeshID(meshID);
            if (bulb) {
                // this.log.info(`Updating switch ID ${switchID}, meshID ${meshID} - on? ${isOn}, brightness ${brightness}`);
                bulb.updateStatus(isOn, brightness, bulb.cyncColorTemp, bulb.rgb);
            }
        }
    }

    lightBulbBySwitchID(switchID) {
        return this.lights.find((bulb) => bulb.switchID == switchID);
    }

    lightBulbByMeshID(meshID) {
        return this.lights.find((bulb) => bulb.meshID == meshID);
    }

    async registerLights() {
        if (this.accessToken) {
            this.log.info("Discovering homes...");
            let r = await fetch(`https://api.gelighting.com/v2/user/${this.config.userID}/subscribe/devices`, {
                headers: {'Access-Token': this.accessToken}
            });
            const data = await r.json();
            this.log.info(`Received home response: ${JSON.stringify(data)}`);

            for (const home of data) {
                let homeR = await fetch(`https://api.gelighting.com/v2/product/${home.product_id}/device/${home.id}/property`, {
                    headers: {'Access-Token': this.accessToken}
                });
                const homeData = await homeR.json();
                this.log.info(`Received device response: ${JSON.stringify(homeData)}`);
                if (homeData.bulbsArray && homeData.bulbsArray.length > 0) {
                    const discovered = [];

                    for (const bulb of homeData.bulbsArray) {
                        const uuid = this.api.hap.uuid.generate(`${bulb.deviceID}`);
                        let accessory = this.accessories.find(accessory => accessory.UUID === uuid);

                        if (!accessory) {
                            // create a new accessory
                            accessory = new this.api.platformAccessory(bulb.displayName, uuid);
                            accessory.addService(new Service.Lightbulb(accessory.context.displayName));

                            this.log.info(`Registering bulb ${bulb.displayName}`);
                            this.api.registerPlatformAccessories('homebridge-cync', 'Cync', [accessory]);
                        }

                        accessory.context.displayName = bulb.displayName;
                        accessory.context.deviceID = bulb.deviceID;
                        accessory.context.meshID = ((bulb.deviceID % home.id) % 1000) + (Math.round((bulb.deviceID % home.id) / 1000) * 256 );
                        accessory.context.switchID = bulb.switchID;
                        accessory.context.deviceType = bulb.deviceType;

                        let light = this.lightBulbBySwitchID(accessory.context.switchID);
                        if (!light) {
                            light = new LightBulb(this.log, accessory, this);
                            this.lights.push(light);
                        }

                        this.updateConnectedDevice(light);
                        discovered.push(uuid);
                    }

                    const remove = this.accessories.filter((accessory) => !discovered.includes(accessory.UUID));
                    for (const accessory of remove) {
                        this.api.unregisterPlatformAccessories('homebridge-cync', 'Cync', [accessory]);
                    }
                }
            }
        }
    }

    /**
     * REQUIRED - Homebridge will call the "configureAccessory" method once for every cached
     * accessory restored
     */
    configureAccessory(accessory) {
        this.accessories.push(accessory);
    }

}

class LightBulb {

    constructor(log, accessory, hub) {
        this.connected = false;
        this.log = log;
        this.accessory = accessory;
        this.name = accessory.context.displayName;
        this.deviceID = accessory.context.deviceID;
        this.switchID = accessory.context.switchID;
        this.meshID = accessory.context.meshID;
        this.on = false;
        this.hub = hub;
        this.brightness = 0;
        this.colorTemp = 0;
        this.cyncColorTemp = 0;
        this.hue = 0;
        this.saturation = 0;
        this.rgb = [0, 0, 0];

        const bulb = accessory.getService(Service.Lightbulb);
        bulb.getCharacteristic(Characteristic.On).onSet((value) => this.setOn(value));

        if (DEVICES_WITH_BRIGHTNESS.includes(accessory.context.deviceType)) {
            bulb.getCharacteristic(Characteristic.Brightness).onSet((value) => this.setBrightness(value));
        }

        if (DEVICES_WITH_COLOR_TEMP.includes(accessory.context.deviceType)) {
            bulb.getCharacteristic(Characteristic.ColorTemperature).onSet((value) => this.setColorTemp(value));
        }

        if (DEVICES_WITH_RGB.includes(accessory.context.deviceType)) {
            bulb.getCharacteristic(Characteristic.Hue).onSet((value) => this.setHue(value));
            bulb.getCharacteristic(Characteristic.Saturation).onSet((value) => this.setSaturation(value));
        }

    }

    getHSV() {
        return [this.hue, this.saturation, this.brightness];
    }

    updateStatus(isOn, brightness, colorTemp, rgb) {
        // if (isOn != this.on || brightness != this.brightness || colorTemp != this.colorTemp)
            this.log.info(`Updating ${this.displayName} with switch ID ${this.switchID}, meshID ${this.meshID} - on? ${isOn}, brightness ${brightness}, temp ${colorTemp}, rgb ${JSON.stringify(rgb)}`);

        this.on = isOn;
        this.brightness = brightness;
        this.cyncColorTemp = colorTemp;
        this.colorTemp = Math.round(((100 - this.cyncColorTemp) * 360) / 100) + 140;
        this.rgb = rgb;
        this.setHSV();

        this.accessory.getService(Service.Lightbulb)
            .getCharacteristic(Characteristic.On)
            .updateValue(this.on);

        if (DEVICES_WITH_BRIGHTNESS.includes(this.accessory.context.deviceType)) {
            this.accessory.getService(Service.Lightbulb)
                .getCharacteristic(Characteristic.Brightness)
                .updateValue(this.brightness);
        }

        if (DEVICES_WITH_COLOR_TEMP.includes(this.accessory.context.deviceType)) {
            this.log.info(`Updating color temp to ${colorTemp}`);
            this.accessory.getService(Service.Lightbulb)
                .getCharacteristic(Characteristic.ColorTemperature)
                .updateValue(this.colorTemp);
        }

        if (DEVICES_WITH_RGB.includes(this.accessory.context.deviceType)) {
            this.accessory.getService(Service.Lightbulb)
                .getCharacteristic(Characteristic.Hue)
                .updateValue(this.hue);

            this.accessory.getService(Service.Lightbulb)
                .getCharacteristic(Characteristic.Saturation)
                .updateValue(this.saturation);
        }
    }

    sendUpdate() {
        const request = Buffer.alloc(16);
        request.writeUInt16BE(this.meshID, 3);
        request.writeUInt8(PACKET_SUBTYPE_SET_STATE, 5);
        request.writeUInt8(this.on, 8);
        request.writeUInt8(this.brightness, 9);
        request.writeUInt8(this.cyncColorTemp, 10);
        request.writeUInt8(this.rgb[0], 11);
        request.writeUInt8(this.rgb[1], 12);
        request.writeUInt8(this.rgb[2], 13);
        request.writeUInt8((496 + this.meshID + (this.on ? 1 : 0) + this.brightness + this.cyncColorTemp + this.rgb[0] + this.rgb[1] + this.rgb[2]) % 256, 14);
        request.writeUInt8(0x7e, 15);
        this.log.info(`Sending update for ${this.name}: ${request.toString('hex')}`);
        this.hub.sendRequest(PACKET_TYPE_STATUS, this.switchID, PACKET_SUBTYPE_SET_STATE, request, true);
    }

    setOn(value) {
        this.on = value;
        this.sendUpdate();
    }

    setBrightness(value) {
        this.brightness = value;
        this.sendUpdate();
    }

    setColorTemp(value) {
        this.colorTemp = value;
        this.cyncColorTemp = 100 - Math.round(((this.colorTemp - 140) * 100) / 360);
        this.sendUpdate();
    }

    setHSV() {
        const hsv = convert.rgb.hsv(this.rgb);
        this.hue = hsv[0];
        this.saturation = hsv[1];
    }

    setRGB() {
        this.rgb = convert.hsv.rgb([this.hue, this.saturation, this.brightness]);
    }

    setHue(value) {
        this.hue = value;
        this.setRGB();
        this.sendUpdate();
    }

    setSaturation(value) {
        this.saturation = value;
        this.setRGB();
        this.sendUpdate();
    }

}

const platform = (api) => {
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    api.registerPlatform("Cync", CyncPlatform);
}

export default platform;