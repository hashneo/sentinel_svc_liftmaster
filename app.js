'use strict';

const SwaggerExpress = require('swagger-express-mw');
const SwaggerUi = require('swagger-tools/middleware/swagger-ui');
const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');

const uuid = require('node-uuid');

const consul = require('consul')( {
    host: process.env.CONSUL || '127.0.0.1',
    promisify: true
});

app.use(bodyParser.json({limit: '50mb'}));
app.use(cookieParser());

var config = {
    appRoot: __dirname, // required config
    swaggerSecurityHandlers: {
        Oauth: (req, authOrSecDef, scopesOrApiKey, cb) => {
            if (scopesOrApiKey == "open") {
                cb();
            }else {
                cb();
            }
        }
    }
};

consul.kv.get('config/sentinel/liftmaster', function(err, result) {
    if (err) throw err;

    let config = JSON.parse(result.Value);

    global.config = config;
    global.myq = require('./myliftmaster.js')(config);
});

process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
    process.exit(1);
});

SwaggerExpress.create(config, function (err, swaggerExpress) {
    if (err) {
        throw err;
    }

    app.use(SwaggerUi(swaggerExpress.runner.swagger));
    // install middleware
    swaggerExpress.register(app);

    let serviceId = process.env.SERVICE_ID || uuid.v4();

    var port = process.env.PORT || 5000;
    var server = app.listen(port, () => {

        let host = require('ip').address();
        let port = server.address().port;

        var module = {
            id: serviceId,
            name: 'sentinel_hikvision',
            address: host,
            port: port,
            check: {
                http: `http://${host}:${port}/health?id=${serviceId}`,
                interval: '15s'
            }
        };

        process.env.SERVICE_ID = serviceId;
        /*
         consul.agent.service.register(module)
         .then((err, result) => {
         if (err)
         throw err;
         })
         .catch((err) => {
         throw err;
         })
         */
    });

    if (swaggerExpress.runner.swagger.paths['/health']) {
        console.log(`you can get /health?id=${serviceId} on port ${port}`);
    }

});

module.exports = app;