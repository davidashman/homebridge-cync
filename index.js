"use strict";

import fetch from 'node-fetch';
import process from 'node:process';
import net from 'node:net';
import { Buffer } from 'node:buffer';

let Service;
let Characteristic;

const PACKET_TYPE_AUTH = 1;
const PACKET_TYPE_STATUS = 4;

class CyncPlatform {

    constructor(log, config, api) {
        // store restored cached accessories here
        this.accessories = [];
        this.lights = [];
        this.log = log;
        this.config = config;
        this.api = api;

        this.api.on('didFinishLaunching', () => {
            this.authenticate().then(() => {
                this.connect();
                this.registerLights();
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
            this.socket = net.connect(23778, "cm.gelighting.com").setKeepAlive(true);
            this.socket.on('readable', () => {
                this.readPackets();
            });
            this.socket.on('end', () => {
                this.log.info(`Connection to Cync has closed.`);
                this.connected = false;
                setTimeout(() => { this.connect() }, 5000);
            });

            const data = Buffer.allocUnsafe(this.config.authorize.length + 10);
            data.writeUInt8(0x03);
            data.writeUInt32BE(this.config.userID, 1);
            data.writeUInt8(0, 5);
            data.writeUInt8(this.config.authorize.length, 6);
            data.write(this.config.authorize, 7, this.config.authorize.length, 'ascii');
            data.writeUInt16BE(0, this.config.authorize.length + 7);
            data.writeUInt8(0xb4, this.config.authorize.length + 9);

            this.log.info("Sending login packet...");
            this.writePacket(PACKET_TYPE_AUTH, data);
        }
    }

    writePacket(type, data) {
        const packet = Buffer.allocUnsafe(data.length + 5);
        packet.writeUInt8((type << 4) | 3);
        packet.writeUInt32BE(0, 1);
        packet.writeUInt8(data.length, 4);
        data.copy(packet, 5);

        this.socket.write(packet);
    }

    readPackets() {
        let packet = {};
        do {
            packet = this.readPacket();

            switch (packet.type) {
                case PACKET_TYPE_AUTH:
                    this.handleConnect(packet);
                    break;
                case PACKET_TYPE_STATUS:
                    this.handleStatus(packet);
                    break;
            }
        } while (packet);
    }

    readPacket() {
        // First read the header
        const header = this.socket.read(5);
        if (header) {
            this.log.info(`Packet header: ${header.toString('hex')}`);
            const type = (header.readUInt8() >>> 4);
            const length = header.readUInt8(4);
            this.log.info(`Received packet of length ${length}...`);

            const data = this.socket.read(length);
            this.log.info(`Data length ${data.length}...`);

            if (data.length == length)
            {
                this.log.info(`Returning packet of type ${type}`);
                return {
                    type: type,
                    length: length,
                    data: data
                }
            }
        }

        return null;
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
        const length = packet.data.readUInt8(14);
        const data = packet.data.subarray(15);

        if (length > data.length || length < 6) {
            this.log.info("Status buffer underflow");
            return;
        }

        const statusData = data.subarray(6, length + 6);
        if (statusData.length % 24 != 0) {
            this.log.info(`Status packet length is wrong: ${statusData.length}`);
            return;
        }

        for (let statusOffset = 0; statusOffset < statusData.length; statusOffset += 24) {
            const status = statusData.subarray(statusOffset, statusOffset + 24);
            const device = status.readUInt8(1);
            const brightness = status.readUInt8(13);
            const tone = status.readUInt8(17);
            const isOn = status.readUInt8(9) != 0;

            this.log.info(`Got status for ${device} with switch ID ${switchID} - on? ${isOn}, brightness ${brightness}, tone ${tone}`);
        }
    }

    lightBulb(deviceID) {
        return lights.find((bulb) => bulb.deviceID == deviceID);
    }

    async registerLights() {
        this.log.info("Discovering homes...");
        let r = await fetch(`https://api.gelighting.com/v2/user/${this.config.userID}/subscribe/devices`, {
            headers: {'Access-Token': this.accessToken}
        });
        const data = await r.json();
        this.log.info(`Received device response: ${JSON.stringify(data)}`);

        for (const home of data) {
            let homeR = await fetch(`https://api.gelighting.com/v2/product/${home.product_id}/device/${home.id}/property`, {
                headers: {'Access-Token': this.accessToken}
            });
            const homeData = await homeR.json();
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
        this.on = false;
        this.hub = hub;
        this.brightness = 100;

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

    updateStatus(data) {
        this.on = data.isOn;
        this.brightness = data.brightness;

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
        }
    }

    setBrightness(value) {
        if (value != this.brightness) {
            this.brightness = value;
        }
    }
}

const platform = (api) => {
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    api.registerPlatform("homebridge-cync", "Cync", CyncPlatform);
}

export default platform;