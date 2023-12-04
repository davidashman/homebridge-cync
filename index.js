"use strict";

import fetch from 'node-fetch';
import process from 'node:process';
import net from 'node:net';
import { Buffer } from 'node:buffer';

let Service;
let Characteristic;

const PACKET_TYPE_AUTH = 1;
const PACKET_TYPE_SYNC = 4;
const PACKET_TYPE_STATUS = 7;
const PACKET_TYPE_STATUS_SYNC = 8;
const PACKET_TYPE_UPDATE = 10;
const PACKET_TYPE_PING = 13;

const PACKET_SUBTYPE_SET_STATUS = 0xd0;
const PACKET_SUBTYPE_SET_BRIGHTNESS = 0xd2;
const PACKET_SUBTYPE_SET_COLOR_TEMP = 0xe2;
const PACKET_SUBTYPE_SET_STATE = 0xf0;
const PACKET_SUBTYPE_GET_STATUS = 0xdb;
const PACKET_SUBTYPE_GET_STATUS_PAGINATED = 0x52;

const PING_BUFFER = Buffer.alloc(0);

class CyncPlatform {

    constructor(log, config, api) {
        // store restored cached accessories here
        this.accessories = [];
        this.lights = [];
        this.log = log;
        this.config = config;
        this.api = api;
        this.seq = 1;

        this.api.on('didFinishLaunching', () => {
            this.authenticate().then(() => {
                this.connect();
                this.registerLights();

                setInterval(() => {
                    this.ping();
                }, 5000);

                setInterval(() => {
                    this.queryStatus();
                }, 2000);

                // setInterval(() => {
                //     this.requestUpdate();
                // }, 2000);
            })
        })
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
    }

    connect() {
        if (!this.connected) {
            this.log.info("Connecting to Cync servers...");
            this.socket = net.connect(23778, "cm.gelighting.com");
            this.socket.on('readable', () => {
                this.readPackets();
            });
            this.socket.on('end', () => {
                this.log.info(`Connection to Cync has closed.`);
                this.connected = false;
                this.connect();
            });

            const data = Buffer.alloc(this.config.authorize.length + 10);
            data.writeUInt8(0x03);
            data.writeUInt32BE(this.config.userID, 1);
            data.writeUInt8(this.config.authorize.length, 6);
            data.write(this.config.authorize, 7, this.config.authorize.length, 'ascii');
            data.writeUInt8(0xb4, this.config.authorize.length + 9);
            this.writePacket(PACKET_TYPE_AUTH, data);
        }
    }

    ping() {
        this.writePacket(PACKET_TYPE_PING, PING_BUFFER);
    }

    writePacket(type, data, log = false) {
        if (type != PACKET_TYPE_AUTH && !this.connected) {
            this.log.info('Skipping packet because not connected.');
            return;
        }

        const packet = Buffer.alloc(data.length + 5);
        packet.writeUInt8((type << 4) | 3);

        if (data.length > 0) {
            packet.writeUInt8(data.length, 4);
            data.copy(packet, 5);
        }

        if (log)
            this.log.info(`Sending packet: ${packet.toString('hex')}`);

        this.socket.write(packet);
    }

    sendRequest(type, switchID, subtype, request, footer = null, log = false) {
        const data = Buffer.alloc(18 + request.length);
        data.writeUInt32BE(switchID);
        data.writeUInt16BE(this.seq++, 4);
        data.writeUInt8(0x7e, 7);
        data.writeUInt8(0xf8, 12);
        data.writeUInt8(subtype, 13); // status query subtype
        data.writeUInt8(request.length, 14);
        request.copy(data, 15);
        if (footer)
            footer.copy(data, 15 + request.length);

        if (log)
            this.log.info(`Sending request: ${data.toString('hex')}`);

        this.writePacket(type, data, log);
    }

    readPackets() {
        let packet = this.readPacket();
        while (packet) {
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
            }

            packet = this.readPacket();
        }
    }

    readPacket() {
        // First read the header
        const header = this.socket.read(5);
        if (header) {
            const type = (header.readUInt8() >>> 4);
            const length = header.readUInt8(4);

            if (length > 0) {
                const data = this.socket.read(length);

                // this.log.info(`Got packet with type ${type}, header ${header.toString('hex')} and body ${data.toString('hex')}`);

                if (data.length == length)
                {
                    return {
                        type: type,
                        length: length,
                        data: data
                    }
                }
                else {
                    this.log.info("Packet length doesn't match.");
                }
            }
            // else {
            //     this.log.info(`Got empty packet with type ${type}, header ${header.toString('hex')}`);
            // }
        }

        return null;
    }

    queryStatus() {
        for (const bulb of this.lights) {
            const data = Buffer.alloc(6);
            data.writeUInt16BE(0xffff, 3);

            const footer = Buffer.alloc(3);
            footer.writeUInt8(0x56, 1);
            footer.writeUInt8(0x7e, 2);

            this.sendRequest(PACKET_TYPE_STATUS, bulb.switchID, PACKET_SUBTYPE_GET_STATUS_PAGINATED, data, footer, false);
        }
    }

    handleConnect(packet) {
        if (packet.data.readUInt16BE() == 0) {
            this.connected = true;
            this.log.info("Cync server connected.");
        }
        else {
            this.connected = false;
            this.log.info("Server authentication failed.");
        }
    }

    handleStatus(packet) {
        const switchID = packet.data.readUInt32BE();
        const responseID = packet.data.readUInt16BE(4);

        const data = Buffer.alloc(7);
        data.writeUInt32BE(switchID);
        data.writeUInt16BE(responseID, 4);
        this.writePacket(PACKET_TYPE_STATUS, data);

        if (packet.length >= 25) {
            const subtype = packet.data.readUInt8(13);
            let status = packet.data;
            switch (subtype) {
                case PACKET_SUBTYPE_GET_STATUS:
                    const meshID = status.readUInt8(21);
                    const state = status.readUInt8(27) > 0;
                    const brightness = state ? status.readUInt8(28) : 0;

                    const bulb = this.lightBulb(meshID);
                    if (bulb) {
                        bulb.updateStatus(state, brightness, bulb.colorTemp, bulb.rgb);
                    }
                case PACKET_SUBTYPE_GET_STATUS_PAGINATED:
                    status = status.subarray(22);
                    while (status.length > 24) {
                        const meshID = status.readUInt8();
                        const state = status.readUInt8(8) > 0;
                        const brightness = state ? status.readUInt8(12) : 0;
                        const colorTemp = status.readUInt8(16);
                        const rgb = {
                            r: status.readUInt8(20),
                            g: status.readUInt8(21),
                            b: status.readUInt8(22),
                            active: status.readUInt8(16) == 254
                        };

                        const bulb = this.lightBulb(meshID);
                        if (bulb) {
                            bulb.updateStatus(state, brightness, colorTemp, rgb);
                        }

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

            const bulb = this.lightBulb(meshID);
            if (bulb) {
                bulb.updateStatus(isOn, brightness, colorTemp, bulb.rgb);
            }
        }
    }

    handleStatusSync(packet) {
        this.log.info(`Got status sync packet: ${packet.data.toString('hex')}`);
        if (packet.length >= 33) {
            const switchID = packet.data.readUInt32BE();
            const meshID = packet.data.readUInt8(21);
            const isOn = packet.data.readUInt8(27) > 0;
            const brightness = isOn ? packet.data.readUInt8(28) : 0;

            const bulb = this.lightBulb(meshID);
            if (bulb) {
                this.log.info(`Updating switch ID ${switchID}, meshID ${meshID} - on? ${isOn}, brightness ${brightness}`);
                bulb.updateStatus(isOn, brightness, bulb.colorTemp, bulb.rgb);
            }
        }
    }
    lightBulb(meshID) {
        return this.lights.find((bulb) => bulb.meshID == meshID);
    }

    async registerLights() {
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
                for (const bulb of homeData.bulbsArray) {
                    const uuid = this.api.hap.uuid.generate(`${bulb.deviceID}`);
                    let accessory = this.accessories.find(accessory => accessory.UUID === uuid);
                    if (accessory) {
                        this.checkServices(accessory, bulb, home);
                        this.log.info(`Skipping bulb for ${accessory.context.displayName} with ID ${accessory.context.deviceID} (switch ${accessory.context.switchID}, meshID ${accessory.context.meshID}) and UUID ${accessory.UUID}.`);
                    }
                    else {
                        // create a new accessory
                        accessory = new this.api.platformAccessory(bulb.displayName, uuid);
                        this.checkServices(accessory, bulb, home);

                        this.log.info(`Creating bulb for ${accessory.context.displayName} with ID ${accessory.context.deviceID} (switch ${accessory.context.switchID}, meshID ${accessory.context.meshID}) and UUID ${accessory.UUID}.`);
                        this.lights.push(new LightBulb(this.log, accessory, this));

                        this.log.info(`Registering bulb ${accessory.context.displayName} with ID ${accessory.context.deviceID}`);
                        this.api.registerPlatformAccessories('homebridge-cync', 'Cync', [accessory]);
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
        if (accessory.context.meshID) {
            this.checkServices(accessory);
            this.accessories.push(accessory);
            if (!this.lights.find(bulb => bulb.deviceID === accessory.context.deviceID)) {
                this.log.info(`Creating bulb for existing accessory ${accessory.context.displayName} with ID ${accessory.context.deviceID} and UUID ${accessory.UUID}.`);
                this.lights.push(new LightBulb(this.log, accessory, this));
            }
        }
        else {
            this.api.unregisterPlatformAccessories('homebridge-cync', 'Cync', [accessory]);
        }
    }

    checkServices(accessory, bulb = null, home = null) {
        if (bulb) {
            accessory.context.displayName = bulb.displayName;
            accessory.context.deviceID = bulb.deviceID;
            accessory.context.meshID = ((bulb.deviceID % home.id) % 1000) + (Math.round((bulb.deviceID % home.id) / 1000) * 256 );
            accessory.context.switchID = bulb.switchID || 0;
        }

        if (!accessory.getService(Service.Lightbulb)) {
            accessory.addService(new Service.Lightbulb(accessory.context.displayName));
        }
    }

}

class LightBulb {

    constructor(log, accessory, hub) {
        this.log = log;
        this.accessory = accessory;
        this.name = accessory.context.displayName;
        this.deviceID = accessory.context.deviceID;
        this.switchID = accessory.context.switchID;
        this.meshID = accessory.context.meshID;
        this.on = false;
        this.hub = hub;
        this.brightness = 100;
        this.colorTemp = 0;
        this.rgb = {
            r: 255,
            g: 255,
            b: 255,
            active: false
        }

        const bulb = accessory.getService(Service.Lightbulb);
        bulb.getCharacteristic(Characteristic.On)
            .onSet((value) => {
                this.setOn(value);
            });
        bulb.getCharacteristic(Characteristic.Brightness)
            .onSet((value) => {
                this.setBrightness(value);
            });
    }

    updateStatus(isOn, brightness, colorTemp, rgb) {
        this.log.info(`Updating switch ID ${this.switchID}, meshID ${this.meshID} - on? ${isOn}, brightness ${brightness}, temp ${colorTemp}`);
        this.on = isOn;
        this.brightness = brightness;
        this.colorTemp = colorTemp;
        this.rgb = rgb;

        this.accessory.getService(Service.Lightbulb)
            .getCharacteristic(Characteristic.On)
            .updateValue(this.on);

        this.accessory.getService(Service.Lightbulb)
            .getCharacteristic(Characteristic.Brightness)
            .updateValue(this.brightness);
    }

    // sendCommand(command, value) {
    //     this.log.info(`Setting ${command} on fireplace ${this.name} status to ${value}`);
    //     if (this.localIP) {
    //         fetch(this.cookieJar, `http://${this.localIP}/get_challenge`)
    //             .then((response) => {
    //                 if (response.ok) {
    //                     response.text().then(challenge => {
    //                         const challengeBuffer = Buffer.from(challenge, 'hex');
    //                         const payloadBuffer = Buffer.from(`${command}=${value})`);
    //                         const sig = createHash('sha256').update(Buffer.concat([this.apiKeyBuffer, challengeBuffer, payloadBuffer])).digest();
    //                         const resp = createHash('sha256').update(Buffer.concat([this.apiKeyBuffer, sig])).digest('hex');
    //
    //                         const params = new URLSearchParams();
    //                         params.append("command", command);
    //                         params.append("value", value);
    //                         params.append("user", this.userId);
    //                         params.append("response", resp);
    //
    //                         fetch(this.cookieJar, 'http://${this.localIP}/post', {
    //                             method: 'POST',
    //                             body: params
    //                         }).then(response => {
    //                             this.power = on;
    //                             this.log.info(`Fireplace update response: ${response.status}`);
    //                         })
    //                     });
    //                 } else {
    //                     this.log.info(`Fireplace ${this.name} power failed to update: ${response.statusText}`);
    //                 }
    //             });
    //     } else {
    //         const params = new URLSearchParams();
    //         params.append(command, value);
    //
    //         fetch(this.cookieJar, `https://iftapi.net/a/${this.serialNumber}//apppost`, {
    //             method: "POST",
    //             body: params
    //         }).then((response) => {
    //             if (response.ok) {
    //                 this.log.info(`Fireplace update response: ${response.status}`);
    //             } else {
    //                 this.log.info(`Fireplace ${this.name} power failed to update: ${response.statusText}`);
    //             }
    //         });
    //     }
    // }

    setOn(value) {
        if (value != this.on) {
            this.on = value;

            const request = Buffer.alloc(13);
            request.writeUInt16LE(this.meshID, 6);
            request.writeUInt8(PACKET_SUBTYPE_SET_STATUS, 8);
            request.writeUInt8(this.on, 11);

            const footer = Buffer.alloc(3);
            footer.writeUInt8((429 + this.meshID + (this.on ? 1 : 0)) % 256, 1);
            footer.writeUInt8(0x7e, 2);

            this.log.info(`Sending status update: ${request.toString('hex')}, footer ${footer.toString('hex')}`);
            this.hub.sendRequest(PACKET_TYPE_STATUS, this.switchID, PACKET_SUBTYPE_SET_STATUS, request, footer, true);
        }
    }

    setBrightness(value) {
        if (value != this.brightness) {
            this.brightness = value;

            const request = Buffer.alloc(11);
            request.writeUInt16LE(this.meshID, 6);
            request.writeUInt8(PACKET_SUBTYPE_SET_STATE, 8);
            request.writeUInt8(this.on, 11);
            request.writeUInt8(this.brightness, 12);
            request.writeUInt8(this.colorTemp, 13);
            request.writeUInt8(this.rgb.r, 14);
            request.writeUInt8(this.rgb.g, 15);
            request.writeUInt8(this.rgb.b, 16);

            const footer = Buffer.alloc(3);
            footer.writeUInt8((496 + this.meshID + (this.on ? 1 : 0) + this.brightness + this.colorTemp + this.rgb.r + this.rgb.g + this.rgb.b) % 256, 1);
            footer.writeUInt8(0x7e, 2);

            this.log.info(`Sending status update: ${request.toString('hex')}, footer ${footer.toString('hex')}`);
            this.hub.sendRequest(PACKET_TYPE_STATUS, this.switchID, PACKET_SUBTYPE_SET_BRIGHTNESS, request, footer, true);
        }
    }
}

const platform = (api) => {
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    api.registerPlatform("homebridge-cync", "Cync", CyncPlatform);
}

export default platform;