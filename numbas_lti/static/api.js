/** A SCORM API.
 * It provides the `window.API_1484_11` object, which SCORM packages use to interact with the data model.
 * It tries to save data back to the server first using a websocket, before falling back to an AJAX request.
 * If all of that fails, it saves data to localStorage, so the client can resume where they left off if they come back later.
 *
 * @param {object} data - A dictionary of the SCORM data model
 * @param {number} attempt_pk - the id of the associated attempt in the database
 * @param {string} fallback_url - URL of the AJAX fallback endpoint
 */
function SCORM_API(data,attempt_pk,fallback_url) {
    var sc = this;

    this.attempt_pk = attempt_pk;
    this.fallback_url = fallback_url;

    /** Key to save data under in localStorage
     */
    this.localstorage_key = 'numbas-lti-attempt-'+this.attempt_pk+'-scorm-data';

    /** We will store changed elements in a queue, to be sent to the server in batches periodically
     */
    this.queue = [];

    /** A dictionary of batches of elements which have been sent, but we haven't received confirmation that the server has saved them.
     *  Maps batch ids to lists of SCORMElements.
     */
    this.sent = {};
    this.element_acc = 0;

    /** An accumulator for the batch IDs
     */
    this.sent_acc = (new Date()).getTime();

    this.initialise_data(data);

    this.initialise_api();

    /** Initialise the WebSocket connection
     */
    this.initialise_socket();

    /** Periodically, update the connection status display
     */
    this.update_interval = setInterval(function() {
        var unreceived = false;
        for(var x in sc.sent) {
            unreceived = true;
            break;
        }
        var queued = sc.queue.length>0;
        var disconnected = !(sc.socket_is_open() || sc.ajax_is_working());

        var ok = !((unreceived || queued) && disconnected);

        if(!ok) {
            sc.last_show_warning = new Date();
        }
        var show_warning = !ok || (new Date()-sc.last_show_warning)<sc.warning_linger_duration;

        var status_display = document.getElementById('status-display');

        function toggle(elem,cls,on) {
            if(on) {
                elem.classList.add(cls);
            } else {
                elem.classList.remove(cls);
            }
        }
        
        toggle(status_display,'ok',ok);
        toggle(status_display,'disconnected',show_warning);
        toggle(status_display,'localstorage-used',sc.localstorage_used||false);
    },50);

    /** Periodically send data over the websocket
     */
    this.socket_interval = setInterval(function() {
        sc.send_queue_socket();
    },this.socket_period);

    this.ajax_interval = setInterval(function() {
        sc.send_ajax();
    },this.ajax_period);
}
SCORM_API.prototype = {

    /** Interval when websocket is connected to send data over websocket, in milliseconds
     */
    socket_period: 50,

    /** Interval when websocket is disconnected to send data over AJAX, in milliseconds
     */
    ajax_period: 5000,

    /** How long the warning message should stay visible after the warning disappears, in milliseconds
     */
    warning_linger_duration: 1000,

    /** Has the API been initialised?
     */
	initialized: false,

    /** Has the API been terminated?
     */
	terminated: false,

    /** The code of the last error that was raised
     */
	last_error: 0,

    /** Setup the SCORM data model.
     *  Merge in elements loaded from the page with elements saved to localStorage, taking the most recent value when there's a clash.
     */
    initialise_data: function(data) {
        var stored_data = this.get_localstorage();

        this.sent = {};
        for(var id in stored_data.sent) {
            this.sent[id] = stored_data.sent[id].map(function(e) {
                return new SCORMData(e.key,e.value,new Date(e.time*1000));
            });
        }

        // merge saved data
        for(var id in this.sent) {
            this.sent_acc = Math.max(this.sent_acc,id);

            var elements = this.sent[id];
            elements.forEach(function(e) {
                var d = data[e.key];
                if(!(e.key in data) || data[e.key].time<e.timestamp()) {
                    data[e.key] = {value:e.value,time:e.timestamp()};
                }
            });
        }

        // create the data model
        this.data = {};
        for(var key in data) {
            this.data[key] = data[key].value;
        }
        
        /** SCORM display mode - 'normal' or 'review'
         */
        this.mode = this.data['cmi.mode'];

        /** Is the client allowed to change data model elements?
         *  Not allowed in review mode.
         */
        this.allow_set = this.mode=='normal';

        // Force review mode from now on if activity is completed - could be out of sync if resuming a session which wasn't saved properly.
        if(this.data['cmi.completion_status'] == 'completed') {
            this.data['cmi.mode'] = this.mode = 'review';
        }
    },

    /** Initialise the SCORM API and expose it to the SCORM activity
     */
    initialise_api: function() {
        var sc = this;

        /** The API object to expose to the SCORM activity
         */
        this.API_1484_11 = {};
        ['Initialize','Terminate','GetLastError','GetErrorString','GetDiagnostic','GetValue','SetValue','Commit'].forEach(function(fn) {
            sc.API_1484_11[fn] = function() {
                return sc[fn].apply(sc,arguments);
            };
        });

        /** Counts for the various lists in the data model
         */
        this.counts = {
            'comments_from_learner': 0,
            'comments_from_lms': 0,
            'interactions': 0,
            'objectives': 0,
        }
        this.interaction_counts = [];

        /** Set the counts based on the existing data model
         */
        for(var key in this.data) {
            this.check_key_counts_something(key);
        }

    },

    initialise_socket: function() {
        var sc = this;

        var ws_scheme = window.location.protocol == "https:" ? "wss" : "ws";
        var ws_url = ws_scheme + '://' + window.location.host + "/websocket/attempt/"+this.attempt_pk+"/scorm_api";

        /** A WebSocket to send data back to the server. It will automatically reconnect, but won't guarantee delivery of messages.
         */
        this.socket = new RobustWebSocket(ws_url);

        this.socket.onmessage = function(e) {
            var d = JSON.parse(e.data);

            // The server sends back confirmation of each batch of elements it received.
            // When we get confirmation, remove that batch from the dict of unconfirmed batches.
            if(d.received) {
                sc.batch_received(d.received);
            }

            if(d.completion_status == 'completed') {
                if(!sc.terminated) {
                    sc.Terminate('');
                    alert("This attempt has been ended in another window. You may not enter any more answers here. Click OK to reload this page.");
                    window.location += '';
                }
            }
        }

        this.socket.onopen = function() {

            // resend any batches we didn't get confirmation messages for
            for(var id in sc.sent) {
                sc.send_elements_socket(sc.sent[id],id);
            }

            // send the current queue
            sc.send_queue_socket();
        }

        this.socket.onerror = function() {
        }
        this.socket.onclose = function() {
        }

    },

    /** Call when we send a batch of elements
     * @param {SCORMData[]} elements
     * @param {number} id
     */
    batch_sent: function(elements,id) {
        this.sent[id] = elements;
        this.set_localstorage();
    },

    /** Call when we've received confirmation that the server got the batch with the given id
     * @param {number} id
     */
    batch_received: function(id) {
        delete sc.sent[id];
        this.set_localstorage();
    },

    /** Store information which hasn't been confirmed received by the server to localStorage.
     */
    set_localstorage: function() {
        try {
            var data = {
                sent: {}
            }
            for(var id in this.sent) {
                data.sent[id] = this.make_batch(this.sent[id]);
            }
            window.localStorage.setItem(this.localstorage_key, JSON.stringify(data));
            this.localstorage_used = true;
        } catch(e) {
            this.localstorage_used = false;
        }
    },

    /** Load saved information from localStorage.
     * @returns {object} of the form `{sent: {id: [{key,value,time,counter}]}}`
     */
    get_localstorage: function() {
        try {
            var stored = window.localStorage.getItem(this.localstorage_key);
            if(stored===null) {
                throw(new Error());
            } else {
                return JSON.parse(stored);
            }
        } catch(e) {
            return {sent:{}};
        }
    },

    /** For a given data model key, if it belongs to a list, update the counter for that list
     */
    check_key_counts_something: function(key) {
        var m;
        if(m=key.match(/^cmi.(\w+).(\d+)/)) {
            var ckey = m[1];
            var n = parseInt(m[2]);
            this.counts[ckey] = Math.max(n+1, this.counts[ckey]);
            this.data['cmi.'+ckey+'._count'] = this.counts[ckey];
            if(ckey=='interactions' && this.interaction_counts[n]===undefined) {
                this.interaction_counts[n] = {
                    'objectives': 0,
                    'correct_responses': 0
                }
            }
        }
        if(m=key.match(/^cmi.interactions.(\d+).(objectives|correct_responses).(\d+)/)) {
            var n1 = parseInt(m[1]);
            var skey = m[2];
            var n2 = parseInt(m[3]);
            this.interaction_counts[n1][skey] = Math.max(n2+1, this.interaction_counts[n1][skey]);
            this.data['cmi.interactions.'+n1+'.'+skey+'._count'] = this.interaction_counts[n1][skey];
        }
    },

    /** Is the WebSocket connection open?
     */
    socket_is_open: function() {
        return this.socket.readyState==WebSocket.OPEN && Object.keys(this.sent).length==0;
    },

    /** Did the last AJAX call succeed?
     */
    ajax_is_working: function() {
        return this.last_ajax_succeeded===undefined || this.last_ajax_succeeded;
    },

    /** Send the queued data model elements, if any, to the server, over the websocket.
     *  If there's nothing to send or the websocket isn't connected, do nothing.
     *  A copy of the sent elements is saved in `this.sent`, so we can resend it if the server doesn't confirm it saved them.
     */
    send_queue_socket: function() {
        if(!this.queue.length || !this.socket_is_open()) {
            return;
        }
        var id = this.sent_acc++;
        this.send_elements_socket(this.queue,id);
        this.batch_sent(this.queue.slice(),id);
        this.queue = [];
    },

    /** Send the given list of data model elements to the server, with the given batch ID.
     *  If the socket is not open, it doesn't send.
     * @param {SCORMData[]} elements
     * @param {number} id
     * @returns {boolean} if the elements were sent.
     */
    send_elements_socket: function(elements,id) {
        if(!this.socket_is_open()) {
            return false;
        }

        var out = this.make_batch(elements);
        this.socket.send(JSON.stringify({id:id, data:out}));
        return true;
    },

    /** Serialise a batch of elements to JSON, ready to send to the server
     * @param {SCORMData[]} elements
     * @returns {object[]}
     */
    make_batch: function(elements) {
        var out = [];
        elements.forEach(function(element) {
            var key = element.key;
            out.push(element.as_json());
        });
        return out;
    },

    /** Send the queued data model elements, as well as any unconfirmed batches, to the server over AJAX.
     * If there's no data to send, or the websocket connection is open, do nothing.
     */
    send_ajax: function() {
        var sc = this;

        if(this.socket_is_open()) {
       //     return;
        }
        if(this.queue.length) {
            var id = this.sent_acc++;
            this.batch_sent(this.queue.slice(),id);
            this.queue = [];
        }

        var stuff_to_send = false;
        var out = {};
        for(var key in this.sent) {
            if(this.sent[key].length) {
                stuff_to_send = true;
                out[key] = this.make_batch(this.sent[key]);
            }
        }
        if(!stuff_to_send) {
            return;
        }

        var csrftoken = getCookie('csrftoken');

        var request = fetch(this.fallback_url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'X-CSRFToken': csrftoken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(out)
        });
        request
            .then(
                function(response) {
                    if(!response.ok) {
                        console.error('failed to send SCORM data over HTTP');
                        response.text().then(function(t){console.error('SCORM HTTP fallback error message: '+t)});
                        sc.last_ajax_succeeded = false;
                        return Promise.reject(error.message);
                    }
                    sc.last_ajax_succeeded = true;
                    return response.json();
                },
                function(error) {
                    console.error('failed to send SCORM data over HTTP: '+error.message);
                    sc.last_ajax_succeeded = false;
                    return Promise.reject(error.message);
                }
            )
            .then(
                function(d) {
                    d.received_batches.forEach(function(id) {
                        sc.batch_received(id);
                    });
                },
                function(e) {
                }
            )
        ;
    },

	Initialize: function(b) {
		if(b!='' || this.initialized || this.terminated) {
			return false;
		}
		this.initialized = true;
		return true;
	},

	Terminate: function(b) {
		if(b!='' || !this.initialized || this.terminated) {
			return false;
		}
		this.terminated = true;
        document.body.classList.add('terminated');

        /** Do one last send over HTTP, to make sure any remaining data is saved straight away.
         */
        this.send_ajax();

		return true;
	},

	GetLastError: function() {
		return this.last_error;
	},

	GetErrorString: function(code) {
		return "I haven't written any error strings yet.";
	},

	GetDiagnostic: function(code) {
		return "I haven't written any error handling yet.";
	},

	GetValue: function(key) {
		var v = this.data[key];
        if(v===undefined) {
            return '';
        } else {
            return v;
        }
	},

	SetValue: function(key,value) {
        if(!this.allow_set) {
            return;
        }
        value = (value+'');
        var changed = value!=this.data[key];
        if(changed) {
    		this.data[key] = value;
            this.check_key_counts_something(key);
            this.queue.push(new SCORMData(key,value, new Date(),this.element_acc++));
        }
	},

    Commit: function(s) {
        return true;
    }
}

/** A single SCORM data model element, with the time it was set.
 */
function SCORMData(key,value,time,counter) {
    this.key = key;
    this.value = value;
    this.time = time;
    this.counter = counter;
}
SCORMData.prototype = {
    as_json: function() {
        return {
            key: this.key,
            value: this.value,
            time: this.timestamp(),
            counter: this.counter
        }
    },

    timestamp: function() {
        return this.time.getTime()/1000
    }
}

function getCookie(name) {
    var cookieValue = null;
    if (document.cookie && document.cookie !== '') {
        var cookies = document.cookie.split(';');
        for (var i = 0; i < cookies.length; i++) {
            var cookie = cookies[i].trim();
            // Does this cookie string begin with the name we want?
            if (cookie.substring(0, name.length + 1) === (name + '=')) {
                cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                break;
            }
        }
    }
    return cookieValue;
}
