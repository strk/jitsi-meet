var SimulcastUtils = require("./SimulcastUtil");
function SimulcastReceiver() {
    this.simulcastUtils = new SimulcastUtils();
    this.logger = this.simulcastUtils.createLogger('SimulcastReceiver');
}

SimulcastReceiver.prototype._remoteVideoSourceCache = '';
SimulcastReceiver.prototype._remoteMaps = {
    msid2Quality: {},
    ssrc2Msid: {},
    msid2ssrc: {},
    receivingVideoStreams: {}
};

SimulcastReceiver.prototype._cacheRemoteVideoSources = function (lines) {
    this._remoteVideoSourceCache = this.simulcastUtils._getVideoSources(lines);
};

SimulcastReceiver.prototype._restoreRemoteVideoSources = function (lines) {
    this.simulcastUtils._replaceVideoSources(lines, this._remoteVideoSourceCache);
};

SimulcastReceiver.prototype._ensureGoogConference = function (lines) {
    var sb;

    this.logger.info('Ensuring x-google-conference flag...')

    if (this.simulcastUtils._indexOfArray('a=x-google-flag:conference', lines) === this.simulcastUtils._emptyCompoundIndex) {
        // TODO(gp) do that for the audio as well as suggested by fippo.
        // Add the google conference flag
        sb = this.simulcastUtils._getVideoSources(lines);
        sb = ['a=x-google-flag:conference'].concat(sb);
        this.simulcastUtils._replaceVideoSources(lines, sb);
    }
};

SimulcastReceiver.prototype._restoreSimulcastGroups = function (sb) {
    this._restoreRemoteVideoSources(sb);
};

/**
 * Restores the simulcast groups of the remote description. In
 * transformRemoteDescription we remove those in order for the set remote
 * description to succeed. The focus needs the signal the groups to new
 * participants.
 *
 * @param desc
 * @returns {*}
 */
SimulcastReceiver.prototype.reverseTransformRemoteDescription = function (desc) {
    var sb;

    if (!desc || desc == null) {
        return desc;
    }

    if (config.enableSimulcast) {
        sb = desc.sdp.split('\r\n');

        this._restoreSimulcastGroups(sb);

        desc = new RTCSessionDescription({
            type: desc.type,
            sdp: sb.join('\r\n')
        });
    }

    return desc;
};


SimulcastReceiver.prototype._updateRemoteMaps = function (lines) {
    var remoteVideoSources = this.simulcastUtils.parseMedia(lines, ['video'])[0],
        videoSource, quality;

    // (re) initialize the remote maps.
    this._remoteMaps.msid2Quality = {};
    this._remoteMaps.ssrc2Msid = {};
    this._remoteMaps.msid2ssrc = {};

    var self = this;
    if (remoteVideoSources.groups && remoteVideoSources.groups.length !== 0) {
        remoteVideoSources.groups.forEach(function (group) {
            if (group.semantics === 'SIM' && group.ssrcs && group.ssrcs.length !== 0) {
                quality = 0;
                group.ssrcs.forEach(function (ssrc) {
                    videoSource = remoteVideoSources.sources[ssrc];
                    self._remoteMaps.msid2Quality[videoSource.msid] = quality++;
                    self._remoteMaps.ssrc2Msid[videoSource.ssrc] = videoSource.msid;
                    self._remoteMaps.msid2ssrc[videoSource.msid] = videoSource.ssrc;
                });
            }
        });
    }
};

SimulcastReceiver.prototype._setReceivingVideoStream = function (resource, ssrc) {
    this._remoteMaps.receivingVideoStreams[resource] = ssrc;
};

/**
 * Returns a stream with single video track, the one currently being
 * received by this endpoint.
 *
 * @param stream the remote simulcast stream.
 * @returns {webkitMediaStream}
 */
SimulcastReceiver.prototype.getReceivingVideoStream = function (stream) {
    var tracks, i, electedTrack, msid, quality = 0, receivingTrackId;

    var self = this;
    if (config.enableSimulcast) {

        stream.getVideoTracks().some(function (track) {
            return Object.keys(self._remoteMaps.receivingVideoStreams).some(function (resource) {
                var ssrc = self._remoteMaps.receivingVideoStreams[resource];
                var msid = self._remoteMaps.ssrc2Msid[ssrc];
                if (msid == [stream.id, track.id].join(' ')) {
                    electedTrack = track;
                    return true;
                }
            });
        });

        if (!electedTrack) {
            // we don't have an elected track, choose by initial quality.
            tracks = stream.getVideoTracks();
            for (i = 0; i < tracks.length; i++) {
                msid = [stream.id, tracks[i].id].join(' ');
                if (this._remoteMaps.msid2Quality[msid] === quality) {
                    electedTrack = tracks[i];
                    break;
                }
            }

            // TODO(gp) if the initialQuality could not be satisfied, lower
            // the requirement and try again.
        }
    }

    return (electedTrack)
        ? new webkitMediaStream([electedTrack])
        : stream;
};

SimulcastReceiver.prototype.getReceivingSSRC = function (jid) {
    var resource = Strophe.getResourceFromJid(jid);
    var ssrc = this._remoteMaps.receivingVideoStreams[resource];

    // If we haven't receiving a "changed" event yet, then we must be receiving
    // low quality (that the sender always streams).
    if (!ssrc) {
        var j, k;

        var remoteStreams = require("../RTC/RTCActivator").getRTCService().remoteStreams;
        if (remoteStreams) {
            for (j = 0; j < remoteStreams.length; j++) {
                var remoteStream = remoteStreams[j].getOriginalStream();

                if (ssrc) {
                    // stream found, stop.
                    break;
                }
                var tracks = remoteStream.getVideoTracks();
                if (tracks) {
                    for (k = 0; k < tracks.length; k++) {
                        var track = tracks[k];
                        var msid = [remoteStream.id, track.id].join(' ');
                        var _ssrc = this._remoteMaps.msid2ssrc[msid];
                        var _jid = require("../xmpp/XMPPActivator").getJIDFromSSRC(_ssrc);
                        var quality = this._remoteMaps.msid2Quality[msid];
                        if (jid == _jid && quality == 0) {
                            ssrc = _ssrc;
                            // stream found, stop.
                            break;
                        }
                    }
                }
            }
        }
    }

    return ssrc;
};

SimulcastReceiver.prototype.getReceivingVideoStreamBySSRC = function (ssrc)
{
    var electedStream;
    var j, k, remoteStream, mediaStream;

    var remoteStreams = require("../RTC/RTCActivator").getRTCService().remoteStreams;
    if (remoteStreams) {
        for (j = 0; j < remoteStreams.length; j++) {
            if (electedStream) {
                // stream found, stop.
                break;
            }

            mediaStream = remoteStreams[j];
            remoteStream = remoteStreams[j].getOriginalStream();
            var tracks = remoteStream.getVideoTracks();
            if (tracks) {
                for (k = 0; k < tracks.length; k++) {
                    var track = tracks[k];
                    var msid = [remoteStream.id, track.id].join(' ');
                    var tmp = this._remoteMaps.msid2ssrc[msid];
                    if (tmp == ssrc) {
                        electedStream = new webkitMediaStream([track]);
                        // stream found, stop.
                        break;
                    }
                }
            }
        }
    }

    return {
        sid: mediaStream.sid,
        stream: electedStream
    };
};

/**
 * Gets the fully qualified msid (stream.id + track.id) associated to the
 * SSRC.
 *
 * @param ssrc
 * @returns {*}
 */
SimulcastReceiver.prototype.getRemoteVideoStreamIdBySSRC = function (ssrc) {
    return this._remoteMaps.ssrc2Msid[ssrc];
};

/**
 * Removes the ssrc-group:SIM from the remote description bacause Chrome
 * either gets confused and thinks this is an FID group or, if an FID group
 * is already present, it fails to set the remote description.
 *
 * @param desc
 * @returns {*}
 */
SimulcastReceiver.prototype.transformRemoteDescription = function (desc) {

    var sb = desc.sdp.split('\r\n');

    this._updateRemoteMaps(sb);
    this._cacheRemoteVideoSources(sb);

    // NOTE(gp) this needs to be called after updateRemoteMaps because we need the simulcast group in the _updateRemoteMaps() method.
    this.simulcastUtils._removeSimulcastGroup(sb);

    // We don't need the goog conference flag if we're not doing native
    // simulcast, but at the receiver, we have no idea if the sender is
    // doing native or not-native simulcast.
    this._ensureGoogConference(sb);

    desc = new RTCSessionDescription({
        type: desc.type,
        sdp: sb.join('\r\n')
    });

    this.logger.fine(['Transformed remote description', desc.sdp].join(' '));

    return desc;
};

module.exports = SimulcastReceiver;