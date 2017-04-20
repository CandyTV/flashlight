var fbutil = require('./fbutil');

function SearchQueue(esc, reqRef, resRef, cleanupInterval) {
   this.esc = esc;
   this.inRef = reqRef;
   this.outRef = resRef;
   this.cleanupInterval = cleanupInterval;
   console.log('Queue started, IN: "%s", OUT: "%s"'.grey, fbutil.pathName(this.inRef), fbutil.pathName(this.outRef));
   setTimeout(function() {
      this.inRef.on('child_added', this._process, this);
   }.bind(this), 1000);
   this._nextInterval();
}

SearchQueue.prototype = {
  _process: function(snap) {
     var dat = snap.val();
     var key = snap.key;

    console.log('processing query request'.grey, key);

     var query = this._buildQuery(key, dat);
     if( query === null ) { return; }

     var method = query.method;
     delete query.method;

     console.log('built query'.grey, JSON.stringify(query));

     switch ( method ) {
       case 'search':
         this.esc.search(query, function(error, response) {
           if (error) {
             this._replyError(key, error);
           } else {
             this._reply(method, key, response);
           }
         }.bind(this));
	 break;

       case 'scroll':
         this.esc.scroll(query, function(error, response) {
           if (error) {
             this._replyError(key, error);
           } else {
             this._reply(method, key, response);
           }
         }.bind(this));
	 break;

       case 'clearScroll':
         this.esc.clearScroll(query, function(error, response) {
           if (error) {
             this._replyError(key, error);
           } else {
             this._reply(method, key, response);
           }
         }.bind(this));
	 break;

       default:
         break;
     }
  },

   _reply: function(method, key, results) {
      if( results.error ) {
         this._replyError(key, results.error);
      }
      else {
	 if ( method === 'clearScroll' ) {
	    if ( results.succeeded ) {
               console.log('clearScroll succeeded, %s freed: %d hits'.yellow, key, results.num_freed);
	    }
            else {
               console.warn('clearScroll failed: %d hits'.red, key);
            }
	 }
	 else {
            console.log('query result %s: %d hits'.yellow, key, results.hits.total);
	 }
         this._send(key, results);
      }
   },

   _replyError: function(key, err) {
     this._send(key, { total: 0, error: fbutil.unwrapError(err), timestamp: Date.now() })
   },

   _send: function(key, data) {
      this.inRef.child(key).remove().catch(this._logErrors.bind(this, 'Unable to remove queue item!'));
      this.outRef.child(key).set(data).catch(this._logErrors.bind(this, 'Unable to send reply!'));
   },

   _logErrors: function(message, err) {
      if( err ) {
         console.error(message.red);
         console.error(err.red);
      }
   },

   _housekeeping: function() {
      var self = this;
     // remove all responses which are older than CHECK_INTERVAL
     this.outRef.orderByChild('timestamp')
       .endAt(new Date().valueOf() - self.cleanupInterval)
       .once('value', function(snap) {
         var count = snap.numChildren();
         if( count ) {
           console.warn('housekeeping: found %d outbound orphans (removing them now) %s'.red, count, new Date());
           snap.forEach(function(ss) { ss.ref.remove(); });
         }
         self._nextInterval();
       });
   },

   _nextInterval: function() {
      var interval = this.cleanupInterval > 60000? 'minutes' : 'seconds';
      console.log('Next cleanup in %d %s'.grey, Math.round(this.cleanupInterval/(interval==='seconds'? 1000 : 60000)), interval);
      setTimeout(this._housekeeping.bind(this), this.cleanupInterval);
   },

   _buildQuery: function(key, queryData) {
     if( !this._assertValidSearch(key, queryData) ) {
       return null;
     }

     // legacy support: q and body were merged on the client as `query`
     // in previous versions; this makes sure they still work
     if( fbutil.isString(queryData.query) ) {
       queryData.q = queryData.query;
     }
     else if( fbutil.isObject(queryData.query) ) {
       queryData.body = queryData.query;
     }

     if( fbutil.isString(queryData.body) ) {
       queryData.body = this._getJSON(queryData.body);
       if( queryData.body === null ) {
         this._replyError(key, 'Search body was a string but did not contain a valid JSON object. It must be an object or a JSON parsable string.');
         return null;
       }
     }

     var query = {};

     Object.keys(queryData).filter(function(k) {
       return k !== 'query';
     }).forEach(function(k) {
       query[k] = queryData[k];
     });

     return query;
   },

    _assertValidSearch: function(key, props) {
      validMethod = ['search', 'scroll', 'clearScroll']
      if ( !fbutil.isObject(props) || validMethod.indexOf(props.method) === -1 ) {
        this._replyError(key, 'Search request must be a valid object with method');
        return false;
      }
      else if ( fbutil.isString(props.method) === 'search' && ( !fbutil.isString(props.index) || !fbutil.isString(props.type) ) ) {
        this._replyError(key, 'Search request must have keys index, type, and one of q or body.');
        return false;
      }
      else if ( fbutil.isString(props.method) === 'scroll' && ( !fbutil.isString(props.scroll) || !fbutil.isString(props.scrollId) ) ) {
        this._replyError(key, 'Scroll request must have scroll and scrollId.');
        return false;
      }
      //else if ( fbutil.isString(props.method) === 'clearScroll' && !fbutil.isString(props.scrollId) ) {
      //else if ( fbutil.isString(props.method) === 'clearScroll' && !fbutil.isString(props.body) ) {
      else if ( fbutil.isString(props.method) === 'clearScroll' && Array.isArray(props.scrollId) ) {
        this._replyError(key, 'Clear Scroll request must have scrollId.');
        return false;
      }
      else {
        return true;
      }
    },


  _getJSON: function(str) {
       try {
           return JSON.parse(str);
       } catch (e) {
           console.log('Error parsing JSON body', e);
           return null;
       }
   }
};

exports.init = function(esc, reqPath, resPath, matchWholeWords, cleanupInterval) {
   new SearchQueue(esc, fbutil.fbRef(reqPath), fbutil.fbRef(resPath), matchWholeWords, cleanupInterval);
};
