var util = require('util');
var net = require('net');
var url = require('url');

var bleno = require('bleno');

var mtu = 80; // max length 101 ?
var headLength = 4; //
var maxSocketSize = 0xffff + 1;
var maxBufferPackageSize = 0xffff + 1;
var maxContent = mtu - 4;
var packageLength = mtu - 3;

var BlenoCharacteristic = bleno.Characteristic;

var EchoCharacteristic = function() {
    EchoCharacteristic.super_.call(this, {
        uuid: 'ec01',
        properties: ['read', 'write', 'notify'],
        value: null
    });
};

util.inherits(EchoCharacteristic, BlenoCharacteristic);

var FINISHED = 0x00;
var CONTINOUSE = 0xff;

const TYPE = {
    URL: 0x00,
    DATA: 0x01
};

// var requestChunks = [];
var srvSocketArray = [];
// var resPackages;
//
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

            for (var i = 0; i < packageSum; i++) {
                var packageBuffer = Buffer.alloc(2);
                var sig = Buffer.alloc(1);
                var index = increaseId++ % maxBufferPackageSize;
                var packBuff = new Buffer(
                    chunkBuff.subarray(i * packageLength, i * packageLength + packageLength)
                );
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

// 处理写数据
// var processingWriteDate = false;
var writeDataArray = [];
var offset = 0;
function processWriteDate() {
    // if (processingWriteDate) {
    //     return;
    // }
    // processingWriteDate = true;

    var check = function() {
        var datas = [];
        for (var i = 0; i < writeDataArray.length; i++) {
            var b = writeDataArray[offset + i];
            if (b && b.length >= 1) {
                datas.push(new Buffer(b.subarray(1))); // delete sig
                var sig = b.readUIntBE(0, 1);
                if (sig === FINISHED) {
                    // update offset
                    offset = offset + i + 1;
                    let allBuff = Buffer.concat(datas);
                    let cltSocketId = allBuff.readUIntBE(0, 2);
                    let contentBuff = new Buffer(allBuff.subarray(3));
                    let type = allBuff.readUIntBE(2, 1);
                    console.log(type)
                    if (type === TYPE.URL) {
                        var urlString = contentBuff.toString();
                        console.log('请求地址：' + urlString);
                        const srvUrl = url.parse(urlString);
                        console.log(srvUrl.port, srvUrl.hostname);
                        var srvSocket = net.connect(srvUrl.port, srvUrl.hostname, function() {
                            console.log('connect to :' + srvUrl.hostname + ':' + srvUrl.port);
                        });
                        srvSocket.on('data', function(chunk) {
                            var cltSocketIdBuff = Buffer.alloc(2);
                            cltSocketIdBuff.writeUIntBE(cltSocketId, 0, 2);
                            var typeDATABuff = Buffer.alloc(1);
                            typeDATABuff.writeUIntBE(TYPE.DATA, 0, 1)
                            console.log('srvSocket data', Buffer.concat([cltSocketIdBuff, typeDATABuff, chunk]))
                            packageManager.createPackages(Buffer.concat([cltSocketIdBuff, typeDATABuff, chunk]));
                        });
                        srvSocketArray[cltSocketId] = srvSocket;
                    } else {
                        var srvSocket = srvSocketArray[cltSocketId];
                        if (!srvSocket) {
                            console.log('can not find srvSocket with ' + cltSocketId);
                        }
                        console.log(contentBuff)
                        console.log(contentBuff.length)
                        srvSocket.write(contentBuff);
                    }
                }
            } else {
                break;
            }
        }
    };

    check()

    // if (!processingWriteDate) {
    //     var finishedSum = 0;
    //     for (var i = 0; i < readConcurrent; i++) {
    //         transfer.read(function(error, data) {
    //             if (++finishedSum >= readConcurrent) {
    //                 if (data && data.length > 0) {
    //                     var index = data.readUIntBE(0, 2);
    //                     recArray[index] = data.subarray(2);
    //                 }
    //                 setTimeout(function() {
    //                     reading = false;
    //                     readRunner();
    //                 }, 100);
    //             }
    //             check();
    //         });
    //     }
    // }
}



EchoCharacteristic.prototype.onReadRequest = function(offset, callback) {
    // console.log(packageManager.getPackages(1))
    callback(this.RESULT_SUCCESS, new Buffer.concat(packageManager.getPackages(1)));
};

EchoCharacteristic.prototype.onWriteRequest = function(data, offset, withoutResponse, callback) {
    console.log('write', data)
    console.log('length', data.length)
    var RESULT_SUCCESS = this.RESULT_SUCCESS;
    if (data.length > 0) {
        var index = data.readUIntBE(0, 2);
        console.log(index)
        writeDataArray[index] = new Buffer(data.subarray(2));
    } else {
        // ?
        // callback(this.RESULT_SUCCESS);
    }
    callback(this.RESULT_SUCCESS);
    processWriteDate();
    // 处理写入数据
    
};

module.exports = EchoCharacteristic;
