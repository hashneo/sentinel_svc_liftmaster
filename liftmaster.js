'use strict';
require('array.prototype.find');

function vera(config) {

    if ( !(this instanceof vera) ){
        return new vera(config);
    }

    const redis = require('redis');

    let pub = redis.createClient({ host: '10.0.1.10' });

    var NodeCache = require( "node-cache" );

    var deviceCache = new NodeCache();
    var statusCache = new NodeCache();

    var merge = require('deepmerge');

    var request = require('request');
    var http = require('http');
    var keepAliveAgent = new http.Agent({ keepAlive: true });

    var categories = require('./device_categories.json');

    var lastDataVersion = 0;
    var lastLoadTime = 0;

    deviceCache.on( "set", function( key, value ){
    });

    statusCache.on( "set", function( key, value ){
        pub.publish("vera.device.update",  JSON.stringify( { id : key, value : value } ) );
    });

    function call(url) {

        return new Promise( ( success, failure ) => {

            if ( config.systemid == null )
                url = 'http://' + config.server + ':3480/data_request?output_format=json&id=' + url;
            else
                url = 'https://' + config.server + '/' + config.user + '/' + config.password + '/' + config.systemid + '/data_request?output_format=json&id=' + url;

            var options = {
                url : url,
                timeout : 30000,
                agent: keepAliveAgent
            };

            try {
                request(options, (err, response, body) => {
                    if (!err && body.indexOf("ERROR:") != 0 && response.statusCode == 200) {
                        success(JSON.parse(body));
                    } else {
                        console.log("request failed => " + err);
                        failure(err);
                    }
                });
            }catch(e){
                console.log("request error => " + e);
                failure(e);
            }
        } );
    }

    this.getDevices = () => {

        return new Promise( (fulfill, reject) => {
            deviceCache.keys( ( err, ids ) => {
                if (err)
                    return reject(err);

                deviceCache.mget( ids, (err,values) =>{
                    if (err)
                        return reject(err);

                    var data = [];

                    for (var key in values) {
                        data.push(values[key]);
                    }

                    fulfill(data);
                });
            });
        });

    };

    this.getDeviceStatus = (id) => {

        return new Promise( (fulfill, reject) => {
            try {
                statusCache.get(id, (err, value) => {
                    if (err)
                        return reject(err);

                    fulfill(value);
                }, true);
            }catch(err){
                reject(err);
            }
        });

    };

    this.callAction = (id, service, action, variable, value, extraParameters) => {
        var url = 'action&action=' + action + '&serviceId=' + service + '&DeviceNum=' + id + '&' + variable + '=' + value;

        if (extraParameters != undefined) {
            Object.keys(extraParameters).forEach(function (key) {
                url += '&' + key + '=' + extraParameters[key];
            });
        }

        return call(url);
    };

    this.setTarget = (id, service, value) => {
        return this.callAction(id, service, 'SetTarget', 'newTargetValue', value);
    };

    this.setLoadLevelTarget = (id, service, value) => {
        return this.callAction(id, service, 'SetLoadLevelTarget', 'newLoadlevelTarget', value);
    };

    this.setModeTarget = (id, service, value) => {
        return this.callAction(id, service, 'SetModeTarget', 'NewModeTarget', value);
    };

    this.setCurrentSetpoint = (id, service, value) => {
        return this.callAction(id, service, 'SetCurrentSetpoint', 'NewCurrentSetpoint', value);
    };

    this.setMode = (id, service, value) => {
        return this.callAction(id, service, 'SetMode', 'NewMode', value);
    };

    function updateStatus() {

        return new Promise( ( fulfill, reject ) => {
            var url = 'status&DataVersion=' + lastDataVersion + '&MinimumDelay=100&Timeout=10&LoadTime=' + lastLoadTime + '&rand=' + Math.random();

            console.log(url);

            call(url)
                .then((data) => {
                    if (data === null || data === undefined || data.DataVersion == undefined) {
                        return reject('nothing returned')
                    }
                    lastDataVersion = data.DataVersion;
                    if (lastLoadTime == 0)
                        lastLoadTime = data.LoadTime;
                    fulfill(data);
                });
        });
    };

    function loadSystem() {

        console.log("Loading System..");

        return new Promise( (fulfill, reject) => {

            call('sdata')

                .then((status) => {

                    if (status === undefined || status.devices == undefined) {
                        reject('no data returned');
                    }

                    var devices = [];

                    for (var i in status.devices) {
                        var device = status.devices[i];

                        var d = {'id': device.id};

                        d['name'] = device['name'];

                        var room = status.rooms.find(function (r) {
                            return r.id == device.room
                        });

                        if (room !== undefined) {
                            var section = status.sections.find(function (r) {
                                return r.id == room.section
                            });
                            d['where'] = {'location': section.name, 'room': room.name};
                        }

                        var type = categories[device.category];

                        if (type !== undefined) {
                            d['type'] = type.name;

                            var subcategory = type.subcategories[device.subcategory];

                            if (subcategory !== undefined) {
                                d['type'] = d['type'] + '.' + subcategory.name;
                            }

                            if (type.variable !== undefined && type.variable !== "") {
                                d['current'] = device[type.variable];
                            }
                        }

                        if (d.type != undefined) {
                            devices.push(d);
                        }

                        deviceCache.set(d.id, d);
                    }

                    fulfill(devices);
                })
        });
    };

    loadSystem()

        .then( () => {

            function processStates(states) {
                var data = {};

                if (states === undefined)
                    return null;

                for (var i in states) {
                    var state = states[i];
                    var service = state['service'];
                    var variable = state['variable'];
                    var value = state['value']
                    if (variable !== undefined) {

                        var serviceData;
                        var match;
                        if (( match = /urn:[a-zA-Z0-9\-]+:serviceId:(\w+)(\d+)(?:_(\w+))?/g.exec(service) ) != null) {

                            var serviceName = match[1];
                            var serviceInstance = match[2];
                            var serviceMode = match[3];

                            if (data[serviceName] == undefined) {
                                data[serviceName] = {};
                            }

                            serviceData = data[serviceName];

                            if (serviceMode !== undefined) {
                                if (serviceData[serviceMode] == undefined) {
                                    serviceData[serviceMode] = {};
                                }

                                serviceData = serviceData[serviceMode];
                            }

                            if (serviceInstance > 1) {
                                if (serviceData[serviceInstance] == undefined) {
                                    serviceData[serviceInstance] = {};
                                }

                                serviceData = serviceData[serviceInstance];
                            }

                            if (variable.toLowerCase() === 'password')
                                value = '********';

                            serviceData[variable] = value;
                        }
                    }
                }

                delete data['ZWaveDevice'];
                delete data['HaDevice'];

                if (data['SwitchPower'] !== undefined) {
                    if (data['SwitchPower']['Target'] !== undefined)
                        data['SwitchPower']['Current'] = data['SwitchPower']['Target'];
                    if (data['SwitchPower']['Status'] !== undefined)
                        data['SwitchPower']['Current'] = data['SwitchPower']['Status'];
                }

                if (data['DoorLock'] !== undefined) {
                    if (data['DoorLock']['Target'] !== undefined)
                        data['DoorLock']['Current'] = data['DoorLock']['Target'];
                    if (data['DoorLock']['Status'] !== undefined)
                        data['DoorLock']['Current'] = data['DoorLock']['Status'];
                }

                if (data['Dimming'] !== undefined) {
                    if (data['Dimming']['LoadLevelTarget'] !== undefined)
                        data['Dimming']['Current'] = data['Dimming']['LoadLevelTarget'];
                    if (data['Dimming']['LoadLevelStatus'] !== undefined)
                        data['Dimming']['Current'] = data['Dimming']['LoadLevelStatus'];

                }
                return data;
            }

            function pollSystem() {

                updateStatus()
                    .then((status) => {

                        for (var i in status.devices) {
                            var device = status.devices[i];

                            var d = deviceCache.get(device.id);

                            if (d !== undefined) {
                                var current = statusCache.get(device.id);

                                var update = processStates(device['states']);

                                if (update) {
                                    if (current !== undefined) {
                                        var newVal = merge(current, update);

                                        if (JSON.stringify(current) !== JSON.stringify(newVal)) {
                                            statusCache.set(device.id, newVal);
                                        }
                                    } else {
                                        statusCache.set(device.id, update);
                                    }
                                }
                            }
                        }

                        //setTimeout(updateStatus, 1000);

                    })
                    .catch((err) => {
                        console.log("status returned error => " + err);
                        lastDataVersion = lastLoadTime = 0;
                    });


            }

            setInterval(pollSystem, 500);
        });

}

module.exports = vera;

