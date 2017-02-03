'use strict';

module.exports.setLightState = (req, res) => {

    let id = req.swagger.params.id.value;
    let state = req.swagger.params.state.value;

    global.myq.setAttribute( id, 'worklightstate', state === 'on' ? '1' : '0' )
        .then( (status) => {
            res.json( { data: { status: status }, result : 'ok' } );
        })
        .catch( (err) => {
            res.status(500).json({code: err.code || 0, message: err.message});
        });
};
