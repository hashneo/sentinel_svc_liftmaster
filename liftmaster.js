require('array.prototype.find');

// based off the https://github.com/pfeffed/liftmaster_myq codebase
function liftmaster(config) {

    if ( !(this instanceof liftmaster) ){
        return new liftmaster(config);
    }

    const redis = require('redis');
    var moment = require('moment');

    let pub = redis.createClient(
        {
            host: process.env.REDIS || global.config.redis || '127.0.0.1' ,
            socket_keepalive: true,
            retry_unfulfilled_commands: true
        }
    );

    pub.on('end', function(e){
        console.log('Redis hung up, committing suicide');
        process.exit(1);
    });

    var NodeCache = require( "node-cache" );

    var deviceCache = new NodeCache();
    var statusCache = new NodeCache();

    var merge = require('deepmerge');

    var request = require('request');

    var jar = request.jar();

    request = request.defaults({jar: jar});

    var https = require('https');
    var keepAliveAgent = new https.Agent({ keepAlive: true });
/*
     require('request').debug = true
     require('request-debug')(request);
*/

    deviceCache.on( 'set', function( key, value ){
        let data = JSON.stringify( { module: 'liftmaster', id : key, value : value });
        console.log( 'sentinel.device.insert => ' + data );
        pub.publish( 'sentinel.device.insert', data);
    });

    deviceCache.on( 'delete', function( key ){
        let data = JSON.stringify( { module: 'liftmaster', id : key });
        console.log( 'sentinel.device.delete => ' + data );
        pub.publish( 'sentinel.device.delete', data);
    });

    statusCache.on( 'set', function( key, value ){
        let data = JSON.stringify( { module: 'liftmaster', id : key, value : value });
        console.log( 'sentinel.device.update => ' + data );
        pub.publish( 'sentinel.device.update', data);
    });

    var api = {
        "login" : "/",
        "system" : "/api/MyQDevices/GetAllDevices?brandName=Liftmaster",
        "set" : "/Device/TriggerStateChange"
    };

    for( let k in api ){
        api[k] = api[k].replace('{appId}', config.appid).replace('{culture}', config.culture);
    }

    var that = this;

    var token = null;

    var typeNameCache = { 'devices' : {}, 'attributes' : {} };

    function processDevice( d ){
        var device = { 'current' : {} };
        device['name'] = d.Name;
        device['id'] = d.MyQDeviceId;
        device['type'] = mapDeviceType( d.DeviceTypeId );
        device['current']['door'] = {};
        device['current']['door']['state'] = stateMap[ parseInt(d.State) ];
        device['current']['door']['updated'] = moment(d.LastUpdateDateTime).format();
        device['current']['door']['locked'] = d.DisableControl;
        return device;
    }

    function call(url, method, data, type){

        return new Promise( (fulfill, reject) => {

            type = type || 'application/json';

            let options = {
                url : 'https://' + config.server + url,
                method : method,
                encoding : null,
                headers : {
                    'accept' : 'application/json',
                    'User-Agent' : 'Mozilla/5.0'
                },
                timeout : 90000,
                agent : keepAliveAgent,
                followRedirect: false
            };

            if ( data === undefined )
                data = null;

            if ( data !== null ){
                if ( type === 'application/json' )
                    data = JSON.stringify(data);

                options['body'] = data;
                options['headers']['content-type'] = type;
            }

            console.log( options.url );
            //console.log( data );

            request(options, (err, response, body) => {

                //console.log(body.toString('utf8'));

                if ( err ) {
                    reject(err);
                    return;
                }

                if (url === api.login && response.statusCode === 302 ){

                    call(response.headers.location, 'GET')
                        .then((result) => {
                            fulfill(result);
                        })
                        .catch((err) => {
                            reject(err);
                        });

                    return;
                }

                try {
                    if (response.headers['content-type'].indexOf('application/json') != -1) {

                        body = JSON.parse(body);

                        if (body.Message) {
                            if (body.Message === 'Authorization has been denied for this request.') {
                                if (url === api.login) {
                                    reject(new Error('Invalid Authorization'));
                                    return;
                                }
                                call(api.login, 'POST', 'Email=' + config.user + '&' + 'Password=' + config.password, 'application/x-www-form-urlencoded')
                                    .then((result) => {
                                        call(url, method, data)
                                            .then((result) => {
                                                fulfill(result);
                                            })
                                            .catch((err) => {
                                                reject(err);
                                            });
                                    })
                                    .catch((err) => {
                                        reject(err);
                                    });
                                return;
                            }
                        }
                    }
                } catch (e) {
                    console.error(err);
                    reject(e);
                    return;
                }

                let cookies = jar.getCookies(options.url);

                let hasSession = false;
                cookies.forEach( (cookie) => {
                    if ( cookie.key === '.AspNet.ApplicationCookie' )
                        hasSession = true;
                });

                if ( !hasSession ){
                    reject( new Error('User could not be authenticated') );
                    return;
                }

                fulfill( body );

            });
        });
    }

    function login(){

    }

    const stateMap = {
        1 : 'open',
        2 : 'closed',
        3 : '3',
        4 : 'opening',
        5 : 'closing'
    };

    this.setAttribute = ( id, attr, value ) => {

        return new Promise( (fulfill, reject) => {

            let url = api.set + '?SerialNumber=' + id + '&attributename=' + attr + '&attributevalue=' + value;
            //https://www.myliftmaster.com/Device/TriggerStateChange?myQDeviceId=653445&attributename=desireddoorstate&attributevalue=1

            return call(url, 'POST' )
                .then( (data) => {
                    let result = {};
                    /*
                    result['id'] = id;
                    result['updated'] = moment(parseInt(data.UpdatedTime)).format();
                    */
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
                .then( (results) => {
                    for( let i in results ) {
                        let d = processDevice(results[i]);
                        if ( d.type !== 'gateway') {
                            statusCache.set(d.id, d.current.door);
                        }
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
                .then( (results) => {
                    let devices = [];
                    for( var i in results ) {
                        var device = results[i];

                        let d = processDevice (device);

                        if ( d.type !== 'gateway') {
                            statusCache.set(d.id, d.current.door);
                            delete d.current;
                            deviceCache.set(d.id, d);
                            devices.push(d);
                        }
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
                        process.exit(1);
                        //setTimeout(pollSystem, 60000);
                    });

            }

            setTimeout(pollSystem, 10000);

        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
    /*
     this.raw = function( params, success, failed ){
     var url = api.system;
     call( url, "get", null, function(data){
     success(data);
     });
     };
     */
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

module.exports = liftmaster;