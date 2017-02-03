require('array.prototype.find');

// based off the https://github.com/pfeffed/liftmaster_myq codebase
function myq(config) {

    if ( !(this instanceof myq) ){
        return new myq(config);
    }

    const redis = require('redis');
    var moment = require('moment');

    let pub = redis.createClient({ host: '10.0.1.10' });

    var NodeCache = require( "node-cache" );

    var deviceCache = new NodeCache();
    var statusCache = new NodeCache();

    var merge = require('deepmerge');

    var request = require('request');
    var https = require('https');
    var keepAliveAgent = new https.Agent({ keepAlive: true });
/*
    require('request').debug = true
    require('request-debug')(request);
*/

    var api = {
		"login" : "/Membership/ValidateUserWithCulture?appId={appId}&securityToken=null&username={username}&password={password}&culture={culture}",
		"system" : "/api/UserDeviceDetails?appId={appId}&securityToken={securityToken}",
		"get" : "/Device/getDeviceAttribute?appId={appId}&securityToken={securityToken}&devId={deviceId}&name={command}",
		"set" : "/Device/setDeviceAttribute"
	};

	for( let k in api ){
		api[k] = api[k].replace('{appId}', config.appid).replace('{culture}', config.culture);
	}	

	var that = this;

	var token = null;

    var typeNameCache = { 'devices' : {}, 'attributes' : {} };

    function processDevice( d ){
        var device = { 'current' : {} };
        device['name'] = d.DeviceName;
        device['id'] = d.DeviceId;
        device['type'] = mapDeviceType( d.MyQDeviceTypeId );
        device['current']['door'] = {};
        device['current']['light'] = { 'on' : false };

        d.Attributes.map(function (a) {
            //if ( a.MyQDeviceTypeAttributeName !== undefined )
            //    typeNameCache.attributes[a.MyQDeviceTypeAttributeId] = a.MyQDeviceTypeAttributeName;
            if (a.Name === 'doorstate') {
                device['current']['door']['state'] = stateMap[ a.Value ];
                device['current']['door']['updated'] = moment(parseInt(a.UpdatedTime)).format();
            } else if (a.Name === 'desc') {
                device['name'] = a.Value;
            } else if (a.Name === 'worklightstate') {
                device['current']['light']['on'] = a.Value == 'on';
                device['current']['light']['updated'] = moment(parseInt(a.UpdatedTime)).format();
            } else if (a.Name === 'vacationmode') {
                device['current']['door']['locked'] = a.Value;
            }
        });

        if ( device.type === 'gateway') {
            delete device.door;
            delete device.light;
        }

        return device;
    }

	function call(url, method, data){

        return new Promise( (fulfill, reject) => {

            if ( token == null  && url !== api.login ){
                call( api.login, 'GET' )
                    .then( (result) => {
                        // make sure no one else already set the token while we were waiting for the callback
                        if ( token === null ) {
                            token = result.SecurityToken;
                            console.log('MyQ Security token => %s', token);
                            config['userId'] = result.UserId;
                        }
                        // Make the original call with the new token
                        call( url, method, data )
                            .then(  (result) =>{
                                fulfill(result);
                            })
                            .catch( (err) =>{
                                reject(err);
                            });
                    })
                    .catch( (err) =>{
                        reject(err);
                    });
                return;
            }

            let options = {
                url : 'https://' + config.server + url.replace('{username}', config.user).replace('{password}',config.password).replace('{securityToken}', token),
                method : method,
                encoding : null,
                headers : { 'accept' : 'application/json'},
                timeout : 90000,
                agent : keepAliveAgent
            };

            if ( data === undefined )
                data = null;

            if ( data !== null ){
                if ( !(data instanceof String) )
                    data = JSON.stringify(data);

                data = data.replace('{securityToken}', token);

                options['body'] = data;

                options['headers']['content-type'] = 'application/json';
                    // options['contentType'] = 'application/json';
            }

            console.log( options.url );
            //console.log( data );

            request(options, (err, response, body) => {
                try {
                    body = JSON.parse(body);
                }catch(e){
                    console.error(err);
                    reject(e);
                    return;
                }

                if (body.ReturnCode === '0') {
                    fulfill( body );
                } else {
                    if ( body.ReturnCode === '-3333' ){
                        console.log('MyQ invalid security token. Need to reset.');
                        token = null;
                        call( url, method, data )
                            .then(  (result) =>{
                                fulfill(result);
                            })
                            .catch( (err) =>{
                                reject(err);
                            });
                        return;
                    }else{
                        console.log('MyQ call error => %s', body.ReturnCode);
                    }
                    reject( {options, body} );
                }
            });
        });
	}

    const stateMap = {
        1 : 'open',
        2 : 'closed',
        3 : '3',
        4 : 'opening',
        5 : 'closing'
    };

    this.getAttribute = ( id, attr ) => {
        let data = {
            'AttributeName' : attr,
            'DeviceId' : id,
            'ApplicationId' : config.appid,
            'AttributeValue' : value,
            'SecurityToken' : '{securityToken}'
        };
        return call( api.get, 'GET', data, function(data){
            let result = {};
            result['id'] = id;
            result['updated'] = moment( parseInt(data.UpdatedTime )).format();
        } );
    };

    this.setAttribute = ( id, attr, value ) => {

        return new Promise( (fulfill, reject) => {

            let data = {
                'AttributeName': attr,
                'DeviceId': id,
                'ApplicationId': config.appid,
                'AttributeValue': value,
                'SecurityToken': '{securityToken}'
            };
            return call(api.set, 'PUT', data )
                .then( (data) => {
                    let result = {};
                    result['id'] = id;
                    result['updated'] = moment(parseInt(data.UpdatedTime)).format();
                    fulfill(result);
                })
                .catch( (err) =>{
                    reject(err);
                })
        });
    };

    function mapDeviceType( type ){
        switch (type ){
            case 1 : // Gateway
                return 'gateway';
            case 2 : // GarageDoorOpener
                return 'garage.opener';
        }

        return type;
    }

    this.getDevices = () => {

        return new Promise( (fulfill, reject) => {
            deviceCache.keys( ( err, ids ) => {
                if (err)
                    return reject(err);

                deviceCache.mget( ids, (err,values) =>{
                    if (err)
                        return reject(err);

                    statusCache.mget( ids, (err, statuses) => {
                        if (err)
                            return reject(err);

                        let data = [];

                        for (let key in values) {
                            let v = values[key];

                            if ( statuses[key] ) {
                                v.current = statuses[key];
                                data.push(v);
                            }
                        }

                        fulfill(data);
                    });

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


    function updateStatus() {
        return new Promise( ( fulfill, reject ) => {
            call( api.system, 'get' )
                .then( (result) => {
                    let  devices = result.Devices;
                    for( let i in devices ) {
                        let d = processDevice(devices[i]);
                        if ( d.current.light ){
                            statusCache.set(d.id + '_light', d.current.light);
                        }
                        statusCache.set(d.id, d.current.door);
                    }
                    fulfill();
                })
                .catch( (err) =>{
                    reject(err);
                });
        });
    }

    this.Reload = () => {
        return new Promise( (fulfill,reject) => {
            fulfill([]);
        });
    };

    function loadSystem(){
        return new Promise( ( fulfill, reject ) => {
            call( api.system, 'get' )
                .then( (result) => {
                    let devices = [];
                    for( var i in result.Devices ) {
                        var device = result.Devices[i];

                        let d = processDevice (device);

                        if ( d.current.light ){
                            let d_light = {};
                            d_light['name'] = d.name + ' (light)';
                            d_light['id'] = d.id + '_light';
                            d_light['type'] = 'switch';
                            deviceCache.set(d_light.id, d_light);
                            statusCache.set(d.id + '_light', d.current.light);
                        }

                        statusCache.set(d.id, d.current.door);
                        delete d.current;
                        deviceCache.set(d.id, d);
                        devices.push(d);
                    }
                    fulfill(devices);
                })
                .catch( (err) =>{
                    reject(err);
                });
        });
    }

    loadSystem()

        .then( () => {

            function pollSystem() {
                updateStatus()
                    .then((devices) => {

                        setTimeout(pollSystem, 10000);
                    })
                    .catch((err) => {
                        console.error(err);
                        setTimeout(pollSystem, 60000);
                    });

            }

            setTimeout(pollSystem, 10000);

        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });

    this.raw = function( params, success, failed ){
        var url = api.system;
        call( url, "get", null, function(data){
            success(data);
        });
    };

	this.system = function( params, success, failed ){
		that.status( null, function( status ){
			var devices = [];

            status.Devices.map( function(d){
                var device = {};

                //if ( d.MyQDeviceTypeName !== undefined )
                //    typeNameCache.devices[d.MyQDeviceTypeId] = d.MyQDeviceTypeName;

                if ( d.MyQDeviceTypeId !== 1 /*Gateway*/ ) {

                    devices.push( processDevice( d ) );
                }
            });

			success( devices );
		});
	};

    return this;
}

module.exports = myq;