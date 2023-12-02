"use strict";

import fetch from 'node-fetch';
import process from 'node:process';
import net from 'node:net';
import { Buffer } from 'node:buffer';

let Service;
let Characteristic;

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

    write(data, cb) {
        if (!this.socket.write(data)) {
            this.socket.once('drain', cb);
        } else {
            process.nextTick(cb);
        }
    }

    connect() {
        if (!this.connected) {
            this.log.info("Connecting to Cync servers...");
            this.socket = net.connect(23778, "cm.gelighting.com").setKeepAlive(true);
            this.socket.on('readable', () => {
                this.readPacket();
            });
            this.socket.on('end', () => {
                this.log.info(`Connection to Cync has closed.`);
                this.connected = false;
                setTimeout(this.connect, 5000);
            });

            const buf = Buffer.allocUnsafe(31);
            buf.write('13000000', 0, 8, 'hex');
            buf.writeInt8(10 + `${this.config.authorize}`.length, 4);
            buf.write('03', 5, 2, 'hex');
            buf.writeInt32BE(this.config.userID, 6);
            buf.writeInt16BE(`${this.config.authorize}`.length, 10);
            buf.write(this.config.authorize, 12, 16, 'ascii');
            buf.write('0000b4', 28, 6, 'hex');

            this.log.info("Sending login packet...");

            this.write(buf, () => {
                this.connected = true;
                this.log.info("Cync server connected.")
            });
        }
    }

    readPacket() {
        // First read the header
        const header = this.socket.read(15);
        const length = header.readInt8(15);
        const packet = this.socket.read(length);

        this.log.info(`Received packet of length ${length}...`);

        if (packet.length % 24 == 0) {
            // only process the packet if it's a multiple of 24
            for (let packetIndex = 0; packetIndex < length; packetIndex += 24) {
                const response = {
                    deviceID: packet.readInt32BE(packetIndex + 1),
                    brightness: packet.readUInt8(packetIndex + 13),
                    colorTone: packet.readUInt8(packetIndex + 17),
                    isOn: packet.readUInt8(packetIndex + 9) != 0
                }

                // get the device and update the status
                this.log.info(`Updating status for ${response.deviceID} with ${JSON.stringify(response)}`);
                this.lightBulb(response.deviceID).updateStatus(response);
            }
        }
    }

    lightBulb(deviceID) {
        return lights.find((bulb) => bulb.deviceID == deviceID);
    }

    async registerLights() {
        this.log.info("Discovering homes...");
        let r = await fetch("https://api.gelighting.com/v2/user/{user}/subscribe/devices", {
            headers: {'Access-Token': this.accessToken}
        });
        let data = await r.json();

        data.forEach((home) => {
            if (home.bulbsArray && home.bulbsArray.length > 0) {
                home.bulbsArray.forEach((bulb) => {
                    const uuid = this.api.hap.uuid.generate(`${bulb.deviceID}`);
                    if (this.accessories.find(accessory => accessory.UUID === uuid)) {
                        this.log.info(`Skipping ${bulb.displayName}...`);
                    }
                    else {
                        this.log.info(`Registering ${bulb.displayName}...`);

                        // create a new accessory
                        const accessory = new this.api.platformAccessory(bulb.displayName, uuid);
                        accessory.context.displayName = bulb.displayName;
                        accessory.context.deviceID = bulb.deviceID;
                        accessory.context.meshID = ((bulb.deviceID % home.id) % 1000) + (Math.round((bulb.deviceID % home.id) / 1000) * 256 );
                        accessory.context.switchID = bulb.switchID || 0;

                        this.checkServices(accessory);

                        this.log.info(`Creating bulb for ${accessory.context.deviceName} with ID ${accessory.context.deviceID} and UUID ${accessory.UUID}.`);
                        this.lights.push(new LightBulb(this.log, accessory, this));

                        this.log.info(`Registering bulb ${accessory.context.deviceName} with ID ${accessory.context.deviceID}`);
                        this.api.registerPlatformAccessories('homebridge-cync', 'Cync', [accessory]);
                    }
                })
            }
        })
    }

    /**
     * REQUIRED - Homebridge will call the "configureAccessory" method once for every cached
     * accessory restored
     */
    configureAccessory(accessory) {
        this.authenticate.then(() => {
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
        })
    }

    checkServices(accessory) {
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

        this.connect();
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