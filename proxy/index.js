var noble = require('noble');
const http = require('http');
const url = require('url');
var deepEqual = require('deep-equal');
const net = require('net');
var mtu = 80; // max length 101 ?
var headLength = 4; //
var maxSocketSize = 0xffff + 1;
var maxBufferPackageSize = 0xffff + 1;
var maxContent = mtu - 4;
var packageLength = mtu - 3;
// 发送并发数
var sendConcurrent = 10;
// 读取并发数
var readConcurrent = 1;

var port = 1086;
var server = new http.Server();
var done = false;

var FINISHED = 0x00;
var CONTINOUSE = 0xff;

const TYPE = {
    URL: 0x00,
    DATA: 0x01
};

var cltSocketManager = (function() {
    var cltArray = [];
    return {
        add: function(cltSocket) {
            cltArray.push(cltSocket);
            if (cltArray.length >= maxSocketSize) {
                throw new Error('maxSocketSize full!!');
            }
            return cltArray.length - 1;
        },
        getSocketById: function(id) {
            return cltArray[id];
        }
    };
})();

/**
 *  | 0xffff |        0xff          |
 *  ---------------------------------
 *  |  id    | FINISHED/CONTINOUSE  |
 */
var packageManager = (function() {
    var increaseId = 0;
    var packageArr = [];
    return {
        getPackages: function(length) {
            return packageArr.splice(0, length);
        },
        createPackages: function(chunkBuff) {
            var buffLength = chunkBuff.length;
            var packageSum = Math.ceil(buffLength / packageLength);

            if (packageArr.length + packageSum > maxBufferPackageSize) {
                throw new Error('maxBufferPackages full!!');
            }

            console.log('packageSum', packageSum);
            for (var i = 0; i < packageSum; i++) {
                var packageBuffer = Buffer.alloc(2);
                var sig = Buffer.alloc(1);
                var index = increaseId++ % maxBufferPackageSize;
                var packBuff = new Buffer(
                    chunkBuff.subarray(i * packageLength, i * packageLength + packageLength)
                );
                console.log('packBuff.length', packBuff.length);

                packageBuffer.writeUIntBE(index, 0, 2);
                if (i === packageSum - 1) {
                    sig.writeUIntBE(FINISHED, 0, 1);
                } else {
                    sig.writeUIntBE(CONTINOUSE, 0, 1);
                }
                packageArr.push(Buffer.concat([packageBuffer, sig, packBuff]));
            }
        }
    };
})();

//test
// createProxy();
// readRunner();

noble.on('stateChange', function(state) {
    if (state === 'poweredOff') {
        console.log('请打开蓝牙设备');
        noble.stopScanning();
    } else if (state === 'poweredOn') {
        noble.startScanning();
    } else {
        console.log('当前蓝牙状态: ' + state);
    }
});

// transfer characteristic
var transfer;

noble.on('discover', function(peripheral) {
    // console.log(peripheral);
    if (peripheral.advertisement.localName === 'echo') {
        peripheral.connect(function(error) {
            peripheral.discoverServices(['ec00'], function(err, services) {
                services[0].discoverCharacteristics(['ec01'], function(err, characteristics) {
                    characteristics.forEach(function(characteristic) {
                        if (characteristic.uuid === 'ec01') {
                            transfer = characteristic;
                        }
                    });
                    createProxy();
                    readRunner();
                });
            });
        });
    }
});

var getIndex = (() => {
    var init = 0;
    return () => {
        return init++ % 0xfffff;
    };
})();

var isSending = false;
function sendRunner() {
    if (!isSending) {
        isSending = true;
        var sendingPackages = packageManager.getPackages(sendConcurrent);
        if (sendingPackages.length === 0) {
            isSending = false;
            return;
        } else {
            var finishedSum = 0;
            sendingPackages.map(function(packBuff) {
                transfer.write(packBuff, false, function(error) {
                    if (++finishedSum >= sendingPackages.length) {
                        // take a break
                        setTimeout(function() {
                            isSending = false;
                            sendRunner();
                        }, 100);
                    }
                });
            });
        }
    }
}

/**
 *  |    0xffff    |   0xff    |
 *  ---------------------------------
 *  |   socketID   | URL/DATA  |
 */
var reading = false;
var recArray = [];
var offset = 0;
function readRunner() {
    var check = function() {
        var datas = [];
        for (var i = 0; i < recArray.length; i++) {
            var b = recArray[offset + i];
            if (b && b.length >= 1) {
                datas.push(new Buffer(b.subarray(1))); // delete sig
                var sig = b.readUIntBE(0, 1);
                if (sig === FINISHED) {
                    console.log('FINISHED');
                    // update offset
                    offset = offset + i + 1;
                    var allBuff = Buffer.concat(datas);
                    var cltSocketId = allBuff.readUIntBE(0, 2);
                    var contentBuff = new Buffer(allBuff.subarray(3));
                    var cltSocket = cltSocketManager.getSocketById(cltSocketId);
                    // console.log(contentBuff.length);
                    cltSocket.write(contentBuff);
                    cltSocket.on('error', function(e) {
                        console.error('cltSocketId: ', cltSocketId, e);
                    });
                }
            } else {
                break;
            }
        }
    };

    if (!reading) {
        var finishedSum = 0;
        for (var i = 0; i < readConcurrent; i++) {
            setTimeout(function () {
                transfer.read(function(error, data) {
                    // if (data.length > 0) {
                    //     console.log(data);
                    if (data && data.length > 0) {
                        var index = data.readUIntBE(0, 2);
                        recArray[index] = new Buffer(data.subarray(2));

                        console.log(data);
                        // console.log(data);
                        check();
                    }

                    // if (++finishedSum >= readConcurrent) {
                        setTimeout(function() {
                            reading = false;
                            readRunner();
                        }, 100);
                    // }

                    // }
                });
            })

        }
    }
}

function createProxy() {
    if (done === true) {
        return;
    }
    done = true;
    server.listen(port, () => {
        console.log(`bluetooth-proxy启动端口: ${port}`);
        server.on('connect', (req, cltSocket, head) => {
            // tunneling https
            var srvUrl = url.parse(`https://${req.url}`);
            console.log(srvUrl.hostname, srvUrl.port);

            if (srvUrl.hostname !== 'ulink.lifeapp.pingan.com.cn') {
                return;
            }

            cltSocket.write(
                'HTTP/1.1 200 Connection Established\r\n' +
                    'Proxy-agent: bluetooth-proxy\r\n' +
                    '\r\n'
            );

            var cltSocketId = cltSocketManager.add(cltSocket);

            var cltSocketIdBuff = Buffer.alloc(2);
            cltSocketIdBuff.writeUIntBE(cltSocketId, 0, 2);
            var typeURLBuff = Buffer.alloc(1);
            typeURLBuff.writeUIntBE(TYPE.URL, 0, 1);
            var urlBuff = new Buffer(`https://${req.url}`);

            // console.log(cltSocketIdBuff, typeURLBuff, urlBuff);

            packageManager.createPackages(Buffer.concat([cltSocketIdBuff, typeURLBuff, urlBuff]));
            sendRunner();

            cltSocket.on('data', function(chunk) {
                // console.log(chunk);
                console.log('cltSocket, chunk.length', chunk.length);
                var typeDATABuff = Buffer.alloc(1);
                typeDATABuff.writeUIntBE(TYPE.DATA, 0, 1);
                var dataChunk = Buffer.concat([cltSocketIdBuff, typeDATABuff, chunk]);
                // console.log(dataChunk.length);
                packageManager.createPackages(dataChunk);
                sendRunner();
            });
        });
    });
}
