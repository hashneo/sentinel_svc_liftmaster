require('array.prototype.find');

// based off the https://github.com/pfeffed/liftmaster_myq codebase
function liftmaster(config) {

    if ( !(this instanceof liftmaster) ){
        return new liftmaster(config);
    }

    const redis = require('redis');
    var moment = require('moment');

    const logger = require('sentinel-common').logger;

    let pub = redis.createClient(
        {
            host: process.env.REDIS || global.config.redis || '127.0.0.1' ,
            socket_keepalive: true,
            retry_unfulfilled_commands: true
        }
    );

    pub.on('end', function(e){
        logger.error('Redis hung up, committing suicide');
        process.exit(1);
    });

    var NodeCache = require( "node-cache" );

    var deviceCache = new NodeCache();
    var statusCache = new NodeCache();

    var merge = require('deepmerge');

    deviceCache.on( 'set', function( key, value ){
        let data = JSON.stringify( { module: 'liftmaster', id : key, value : value });
        logger.info( 'sentinel.device.insert => ' + data );
        pub.publish( 'sentinel.device.insert', data);
    });

    deviceCache.on( 'delete', function( key ){
        let data = JSON.stringify( { module: 'liftmaster', id : key });
        logger.info( 'sentinel.device.delete => ' + data );
        pub.publish( 'sentinel.device.delete', data);
    });

    statusCache.on( 'set', function( key, value ){
        let data = JSON.stringify( { module: 'liftmaster', id : key, value : value });
        logger.debug( 'sentinel.device.update => ' + data );
        pub.publish( 'sentinel.device.update', data);
    });

    const that = this;

    let skipPoll = false;

    const MyQ = require('myq-api');

    const account = new MyQ();

    function login() {

        return new Promise( (fulfill, reject) => {

            account.login(global.config.user, global.config.password)
                .then((result) => {
                    fulfill(account);
                })
                .catch((err) => {
                    logger.error(err);
                    reject(err);
                });
        });
    }

    this.setDoorState = (id, state) => {
        return new Promise( (fulfill, reject) => {

            deviceCache.get( id, (err) => {
                if (err)
                    return reject(err);

                statusCache.get( id, (err,value) => {
                    if (err)
                        return reject(err);

                    switch ( state ){
                        case 'open':
                            if ( value.state === 'opening')
                                return reject( { code : 409, message : 'door currently opening' } );
                            if ( value.state === 'closing')
                                return reject( { code : 409, message : 'door currently closing' } );
                            if ( value.state === 'open')
                                return fulfill( 'open' );
                            value.state = 'opening';
                            break;
                        case 'close':
                            if ( value.state === 'closing')
                                return reject( { code : 409, message : 'door currently closing' } );
                            if ( value.state === 'opening')
                                return reject( { code : 409, message : 'door currently opening' } );
                            if ( value.state === 'closed')
                                return fulfill( 'closed' );
                            value.state = 'closing';
                            break;
                    }

                    login()
                        .then(function (result) {
                            return account.setDoorState(id, state === 'open' ? MyQ.actions.door.OPEN : MyQ.actions.door.CLOSE);
                        })
                        .then(function (result) {
                            skipPoll = true;
                            statusCache.set( id, value);
                            //updateStatus();
                            fulfill( value.state );
                        })
                        .catch(function (err) {
                            logger.error(err);
                            reject(err);
                        });
                });

            });
        })
    };

    function mapDeviceType(type){
        switch (type){
            case 'ethernetgateway':
                return 'gateway';
            case 'garagedooropener':
                return 'garage.opener';
        }
        return null;
    }

    function processDevice( d ){
        let device = { 'current' : {} };
        device['name'] = d.name;
        device['id'] = d.serial_number;
        device['type'] = mapDeviceType( d.device_type );

        if ( d.device_type === 'garagedooropener') {
            device['current']['door'] = {};
            device['current']['door']['state'] = d.state.door_state;
            device['current']['door']['updated'] = d.state.last_update;
        }
        return device;
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
                                delete v.myq;
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

            if ( skipPoll ){
                skipPoll = false;
                return fulfill();
            }

            login()
                .then( (context) => {
                    return context.getDevices();
                })
                .then( (results) => {
                    for( let i in results.devices ) {
                        let d = processDevice(results.devices[i]);
                        if ( d.type !== 'gateway') {
                            try {
                                statusCache.set(d.id, d.current.door);
                            }
                            catch(err){
                                reject(err);
                            }
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

            login()
                .then( (context) => {
                    return context.getDevices();
                })
                .then( (results) => {

                    let devices = [];

                    for( let i in results.devices ) {
                        let device = results.devices[i];

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
                        logger.error(err);
                        process.exit(1);
                        //setTimeout(pollSystem, 60000);
                    });

            }

            setTimeout(pollSystem, 10000);

        })
        .catch((err) => {
            logger.error(err);
            process.exit(1);
        });

    return this;
}

module.exports = liftmaster;