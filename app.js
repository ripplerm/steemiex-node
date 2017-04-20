var Gateway = require('./gateway');

// ================================================================

var g = new Gateway();

g.loadSignerList(function () {
	console.log('signerList loaded.')
	g.init();
});

// update_db periodically;
setInterval(function () {
	g.update_db(50);
}, 1000 * 3600 * 2);
