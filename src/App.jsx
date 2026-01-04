import React, { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { 
  QrCode, Scan, Clock, X, Download, Shield, Plus, ArrowLeft, 
  Lock, User, CheckCircle, AlertCircle, AlertTriangle, 
  DoorOpen, Trash2, RefreshCcw, LogOut
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { saveAs } from 'file-saver';

// --- CONFIGURATION ---
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- UTILITIES ---
const generateCSV = (participants, eventName) => {
  const headers = "Student ID,Name,Email,Status,Time In,Time Out,Total Logs\n";
  const rows = participants.map(p => {
    // Robust Log Finder
    const inLog = p.logs?.find(l => l.type.toLowerCase().includes('in'));
    const outLog = [...(p.logs || [])].reverse().find(l => 
      l.type.toLowerCase().includes('out') || 
      l.type.toLowerCase().includes('checkout')
    );

    const fmtIn = inLog ? new Date(inLog.time).toLocaleTimeString() : '-';
    const fmtOut = outLog ? new Date(outLog.time).toLocaleTimeString() : '-';
    
    return `${p.student_id},"${p.full_name}",${p.email},${p.status},${fmtIn},${fmtOut},${p.logs?.length || 0}`;
  }).join("\n");
  const blob = new Blob([headers + rows], { type: "text/csv;charset=utf-8" });
  saveAs(blob, `${eventName}_Report.csv`);
};

// --- COMPONENTS ---

const AdminPanel = ({ goBack }) => {
  const [managers, setManagers] = useState([]);
  useEffect(() => { 
    supabase.from('profiles').select('*').eq('role', 'manager').then(({data}) => setManagers(data || [])); 
  }, []);

  const toggleApproval = async (id, status) => {
    await supabase.from('profiles').update({ is_approved: !status }).eq('id', id);
    const { data } = await supabase.from('profiles').select('*').eq('role', 'manager');
    setManagers(data || []);
  };

  return (
    <div className="min-h-screen bg-slate-100 p-6">
      <div className="max-w-4xl mx-auto bg-white rounded-2xl shadow-sm overflow-hidden">
        <div className="p-6 border-b flex justify-between items-center">
          <h2 className="text-xl font-bold flex items-center gap-2 text-slate-800"><Shield className="text-indigo-600"/> Admin Console</h2>
          <button onClick={goBack} className="text-sm font-bold text-slate-500 hover:text-red-500">Log Out</button>
        </div>
        <div className="divide-y">
          {managers.map(m => (
            <div key={m.id} className="p-4 flex justify-between items-center hover:bg-slate-50">
              <div><div className="font-bold text-slate-800">{m.email}</div><div className="text-xs text-slate-400">ID: {m.id.slice(0,8)}</div></div>
              <button onClick={() => toggleApproval(m.id, m.is_approved)} className={`px-4 py-2 rounded-lg text-xs font-bold ${m.is_approved ? 'bg-red-50 text-red-600' : 'bg-green-600 text-white'}`}>
                {m.is_approved ? 'Revoke' : 'Approve'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const ManagerDashboard = ({ user, onLogout }) => {
  const [view, setView] = useState('list');
  const [events, setEvents] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [newEvent, setNewEvent] = useState({ name: '', lateTime: '' });
  const [participants, setParticipants] = useState([]);
  
  // SCANNER STATE
  const [scanMode, setScanMode] = useState(false);
  const [activePhase, setActivePhase] = useState('reg'); 
  const activePhaseRef = useRef('reg');

  // --- REALTIME SYNC + FETCH ---
  useEffect(() => {
    let channel;
    if (view === 'event-detail' && selectedEvent) {
      fetchParticipants(selectedEvent.id);

      channel = supabase
        .channel('public:participants')
        .on('postgres_changes', 
          { event: '*', schema: 'public', table: 'participants', filter: `event_id=eq.${selectedEvent.id}` }, 
          (payload) => {
             // When DB updates, refresh list
             fetchParticipants(selectedEvent.id);
          }
        )
        .subscribe();
    }
    return () => { if (channel) supabase.removeChannel(channel); };
  }, [view, selectedEvent]);

  useEffect(() => { loadEvents(); }, []);
  useEffect(() => { activePhaseRef.current = activePhase; }, [activePhase]);

  const loadEvents = async () => {
    const { data } = await supabase.from('events').select('*').order('created_at', { ascending: false });
    if (data) setEvents(data);
  };

  const createEvent = async () => {
    if (!newEvent.name) return;
    let lateThreshold = null;
    if (newEvent.lateTime) {
      const d = new Date();
      const [h, m] = newEvent.lateTime.split(':');
      d.setHours(h, m, 0, 0);
      lateThreshold = d.toISOString();
    }
    const { error } = await supabase.from('events').insert([{ name: newEvent.name, created_by: user.id, late_threshold: lateThreshold }]);
    if (!error) { setNewEvent({ name: '', lateTime: '' }); setView('list'); loadEvents(); }
  };

  const deleteEvent = async (e, id) => {
    e.stopPropagation();
    if (!confirm("⚠️ DELETE WARNING: This will delete the event and ALL participant records forever. Confirm?")) return;
    await supabase.from('events').delete().eq('id', id);
    loadEvents();
  };

  const deleteParticipant = async (id) => {
    if (!confirm("Remove this participant?")) return;
    // Optimistic Delete
    setParticipants(prev => prev.filter(p => p.id !== id));
    await supabase.from('participants').delete().eq('id', id);
  };

  const toggleCheckoutMode = async () => {
    const newState = !selectedEvent.is_open_for_checkout;
    // Optimistic Update
    setSelectedEvent({...selectedEvent, is_open_for_checkout: newState});
    setActivePhase(newState ? 'out' : 'reg');
    await supabase.from('events').update({ is_open_for_checkout: newState }).eq('id', selectedEvent.id);
  };

  const openEvent = (ev) => { 
    setSelectedEvent(ev); 
    setView('event-detail'); 
    setActivePhase(ev.is_open_for_checkout ? 'out' : 'reg');
  };

  const fetchParticipants = async (eventId) => {
    const { data } = await supabase.from('participants').select('*').eq('event_id', eventId).order('full_name');
    if (data) setParticipants(data);
  };

  const handleScan = async (decodedText) => {
    const [prefix, pId, eId] = decodedText.split(':');
    if (prefix !== 'EVENTFLOW' || eId != selectedEvent.id) return;

    // FIND LOCAL DATA FIRST
    const localP = participants.find(x => x.student_id === pId);
    if (!localP) return;

    const phase = activePhaseRef.current;
    const now = new Date();
    let newStatus = localP.status;
    let logType = '';

    if (phase === 'reg') {
       if (localP.status !== 'registered') return; // Already In
       if (selectedEvent.late_threshold && now > new Date(selectedEvent.late_threshold)) {
          newStatus = 'late'; logType = 'Late Time In (Auto)';
       } else {
          newStatus = 'present'; logType = 'Time In';
       }
    }
    else if (phase === 'break') {
       if (localP.status === 'break') { newStatus = 'present'; logType = 'Break Return'; }
       else if (['present', 'late'].includes(localP.status)) { newStatus = 'break'; logType = 'Break Start'; }
       else return;
    }
    else if (phase === 'out') {
       if (localP.status === 'checked_out') return;
       newStatus = 'checked_out'; logType = 'Time Out';
    }

    const newLogs = [...(localP.logs || []), { type: logType, time: now.toISOString() }];

    // 1. OPTIMISTIC UPDATE (Update UI Instantly)
    setParticipants(prev => prev.map(p => p.id === localP.id ? { ...p, status: newStatus, logs: newLogs } : p));

    // 2. DB UPDATE (Background)
    await supabase.from('participants').update({ status: newStatus, logs: newLogs }).eq('id', localP.id);
  };

  const QRScanner = () => {
    useEffect(() => {
      const scanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: 250 }, false);
      scanner.render(handleScan, console.warn);
      return () => { try { scanner.clear(); } catch(e){} };
    }, []);
    return <div id="reader" className="rounded-lg overflow-hidden border-2 border-indigo-500"></div>;
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-20">
      <div className="bg-white px-4 py-4 sticky top-0 z-10 border-b flex justify-between items-center shadow-sm">
        <h1 className="font-bold text-lg text-indigo-700 flex items-center gap-2"><Clock/> Manager</h1>
        <button onClick={onLogout} className="text-xs font-bold text-slate-500">EXIT</button>
      </div>

      <div className="p-4 max-w-3xl mx-auto">
        {view === 'list' && (
          <div className="animate-fade-in">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-slate-800">Events</h2>
              <button onClick={() => setView('create')} className="bg-indigo-600 text-white p-3 rounded-full shadow-lg"><Plus/></button>
            </div>
            <div className="space-y-4">
              {events.map(ev => (
                <div key={ev.id} onClick={() => openEvent(ev)} className="bg-white p-5 rounded-xl border border-slate-100 shadow-sm relative overflow-hidden group active:scale-[0.98] transition">
                  <div className={`absolute left-0 top-0 bottom-0 w-1 ${ev.status === 'active' ? 'bg-green-500' : 'bg-slate-300'}`}></div>
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-bold text-lg text-slate-800">{ev.name}</h3>
                      {ev.late_threshold && <div className="text-xs text-orange-600 mt-1 flex items-center gap-1"><AlertTriangle size={10}/> Late after: {new Date(ev.late_threshold).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>}
                    </div>
                    <button onClick={(e) => deleteEvent(e, ev.id)} className="p-2 text-slate-200 hover:text-red-500 z-10"><Trash2 size={18}/></button>
                  </div>
                  {ev.is_open_for_checkout && <div className="mt-2 inline-block px-2 py-1 bg-blue-100 text-blue-700 text-[10px] font-bold rounded">CHECKOUT OPEN</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {view === 'create' && (
          <div className="bg-white p-6 rounded-xl shadow-sm mt-4 animate-scale-in">
            <h2 className="text-xl font-bold mb-4">Create Event</h2>
            <div className="space-y-4">
              <input type="text" placeholder="Event Name" className="w-full p-3 border rounded-lg bg-slate-50" value={newEvent.name} onChange={e=>setNewEvent({...newEvent, name:e.target.value})} />
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Late Time Threshold (Optional)</label>
                <div className="flex items-center gap-2 p-3 border rounded-lg bg-slate-50">
                   <Clock size={16} className="text-slate-400"/>
                   <input type="time" className="bg-transparent w-full outline-none" value={newEvent.lateTime} onChange={e=>setNewEvent({...newEvent, lateTime:e.target.value})} />
                </div>
                <p className="text-[10px] text-slate-400 mt-1">Students scanning after this time will be marked LATE automatically.</p>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setView('list')} className="flex-1 py-3 text-slate-500 font-bold">Cancel</button>
              <button onClick={createEvent} className="flex-1 py-3 bg-indigo-600 text-white rounded-lg font-bold shadow-lg">Create</button>
            </div>
          </div>
        )}

        {view === 'event-detail' && selectedEvent && (
          <div className="animate-fade-in">
            <button onClick={() => setView('list')} className="mb-4 text-slate-500 flex items-center gap-1"><ArrowLeft size={16}/> Back</button>
            
            <div className="bg-white p-5 rounded-2xl shadow-sm mb-4 border border-slate-100">
               <div className="flex justify-between items-start mb-4">
                 <h1 className="text-2xl font-bold text-slate-800">{selectedEvent.name}</h1>
                 <button onClick={() => generateCSV(participants, selectedEvent.name)} className="px-3 py-2 bg-slate-50 border rounded-lg hover:bg-slate-100"><Download size={18} className="text-slate-600"/></button>
               </div>
               
               <div className="bg-slate-50 p-1 rounded-xl flex mb-4 border border-slate-200">
                 <button onClick={() => setActivePhase('reg')} className={`flex-1 py-2 text-xs font-bold rounded-lg transition ${activePhase === 'reg' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-400'}`}>Time In</button>
                 <button onClick={() => setActivePhase('break')} className={`flex-1 py-2 text-xs font-bold rounded-lg transition ${activePhase === 'break' ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-400'}`}>Breaks</button>
                 <button onClick={() => { if(!selectedEvent.is_open_for_checkout) toggleCheckoutMode(); else setActivePhase('out'); }} className={`flex-1 py-2 text-xs font-bold rounded-lg transition ${activePhase === 'out' ? 'bg-white text-red-600 shadow-sm' : 'text-slate-400'}`}>Checkout</button>
               </div>

               <div className="mb-4 text-center">
                  {activePhase === 'reg' && <div className="text-xs text-indigo-600 font-medium">Scanner Mode: <b className="text-indigo-800">Time In / Late</b></div>}
                  {activePhase === 'break' && <div className="text-xs text-orange-600 font-medium">Scanner Mode: <b className="text-orange-800">Break In/Out</b></div>}
                  {activePhase === 'out' && <div className="text-xs text-red-600 font-medium">Scanner Mode: <b className="text-red-800">Time Out</b></div>}
               </div>

               <button onClick={() => setScanMode(!scanMode)} className={`w-full py-3 rounded-lg font-bold flex justify-center gap-2 items-center transition ${scanMode ? 'bg-slate-800 text-white' : 'bg-indigo-600 text-white shadow-lg shadow-indigo-200'}`}>
                 <Scan size={18}/> {scanMode ? 'Close Camera' : 'Start Scanning'}
               </button>
               
               {scanMode && (
                 <div className="mt-4 bg-black p-2 rounded-xl text-center">
                   <QRScanner/>
                   <p className="text-white text-xs mt-2 opacity-50">Point at student QR</p>
                 </div>
               )}
            </div>
            
            <div className="mb-4 flex items-center justify-between bg-white p-4 rounded-xl border border-slate-100">
               <span className="text-sm font-bold text-slate-700">Allow Self-Checkout?</span>
               <button onClick={toggleCheckoutMode} className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${selectedEvent.is_open_for_checkout ? 'bg-green-500' : 'bg-slate-300'}`}>
                 <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${selectedEvent.is_open_for_checkout ? 'translate-x-6' : 'translate-x-1'}`}/>
               </button>
            </div>

            <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
               <div className="p-4 bg-slate-50 border-b text-xs font-bold text-slate-500 uppercase flex justify-between items-center">
                 <span>Participants</span>
                 <div className="flex gap-2 items-center">
                    <span className="text-[10px] bg-green-50 text-green-700 px-2 py-1 rounded border border-green-100 flex items-center gap-1">
                      <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div> LIVE
                    </span>
                    <span>{participants.length}</span>
                 </div>
               </div>
               <div className="divide-y divide-slate-50 max-h-96 overflow-y-auto">
                 {participants.map(p => (
                   <div key={p.id} className="p-3 flex justify-between items-center hover:bg-slate-50 group">
                     <div>
                       <div className="font-bold text-slate-800 text-sm">{p.full_name}</div>
                       <div className="text-[10px] text-slate-400">{p.student_id}</div>
                     </div>
                     <div className="flex items-center gap-3">
                        <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${
                          p.status === 'present' ? 'bg-green-100 text-green-700' :
                          p.status === 'late' ? 'bg-yellow-100 text-yellow-700' :
                          p.status === 'break' ? 'bg-orange-100 text-orange-700' :
                          p.status === 'checked_out' ? 'bg-slate-100 text-slate-500' : 'bg-blue-50 text-blue-600'
                        }`}>{p.status.replace('_', ' ')}</span>
                        <button onClick={() => deleteParticipant(p.id)} className="text-slate-300 hover:text-red-500"><Trash2 size={16}/></button>
                     </div>
                   </div>
                 ))}
               </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// 3. PARTICIPANT VIEW
const ParticipantView = ({ onStaffAccess }) => {
  const [mode, setMode] = useState('select'); 
  const [events, setEvents] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [formData, setFormData] = useState({ name: '', sid: '', email: '', phone: '' });
  const [loginId, setLoginId] = useState('');
  const [myParticipantData, setMyParticipantData] = useState(null);

  useEffect(() => { 
    const fetchEvents = async () => {
       const { data } = await supabase.from('events').select('*').eq('status', 'active');
       if (data) setEvents(data);
    };
    fetchEvents();
  }, []);

  useEffect(() => {
    let interval;
    if (mode === 'dashboard' && myParticipantData) {
      interval = setInterval(async () => {
        const { data } = await supabase.from('participants').select('*').eq('id', myParticipantData.id).single();
        if (data) setMyParticipantData(data);
        const { data: ev } = await supabase.from('events').select('is_open_for_checkout').eq('id', selectedEvent.id).single();
        if (ev) setSelectedEvent(prev => ({...prev, is_open_for_checkout: ev.is_open_for_checkout}));
      }, 5000);
    }
    return () => clearInterval(interval);
  }, [mode, myParticipantData]);

  const handleRegister = async (e) => {
    e.preventDefault();
    if (!selectedEvent) return;
    let initialStatus = 'present';
    let logType = 'Time In (Auto)';
    
    if (selectedEvent.late_threshold) {
      if (new Date() > new Date(selectedEvent.late_threshold)) {
        initialStatus = 'late';
        logType = 'Late Time In (Auto)';
      }
    }

    const { data, error } = await supabase.from('participants').insert([{
      event_id: selectedEvent.id, full_name: formData.name, student_id: formData.sid, email: formData.email, phone: formData.phone,
      status: initialStatus, logs: [{ type: logType, time: new Date().toISOString() }]
    }]).select().single();

    if (error) {
      if (error.code === '23505') alert("This Student ID is already registered. Please Login.");
      else alert("Error: " + error.message);
    } else {
      setMyParticipantData(data);
      setMode('dashboard');
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    const { data, error } = await supabase.from('participants').select('*').eq('event_id', selectedEvent.id).eq('student_id', loginId).single();
    if (error || !data) alert("Student ID not found.");
    else { setMyParticipantData(data); setMode('dashboard'); }
  };

  const selfCheckout = async () => {
    if (!confirm("Confirm Time Out?")) return;
    const now = new Date().toISOString();
    const newLogs = [...(myParticipantData.logs || []), { type: "Self Checkout", time: now }];
    
    // OPTIMISTIC UPDATE
    setMyParticipantData({...myParticipantData, status: 'checked_out', logs: newLogs});
    
    const { error } = await supabase.from('participants').update({ status: 'checked_out', logs: newLogs }).eq('id', myParticipantData.id);
    
    if (error) {
        alert("Network Error: Could not save to database.");
        // Revert optimization if error (Optional but safer)
        setMyParticipantData({...myParticipantData});
    } else {
        alert("Timed Out Successfully!");
        setMode('select');
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <div className="flex-1 p-6 flex flex-col items-center">
        {mode === 'select' && (
           <div className="w-full max-w-md mt-8 animate-fade-in">
             <div className="text-center mb-10">
               <div className="inline-block p-4 bg-indigo-600 rounded-2xl shadow-lg shadow-indigo-200 mb-4"><QrCode className="text-white w-8 h-8"/></div>
               <h1 className="text-3xl font-black text-slate-800">EventFlow</h1>
               <p className="text-slate-500">Student Access</p>
             </div>
             <div className="space-y-3">
               {events.map(ev => (
                 <button key={ev.id} onClick={() => { setSelectedEvent(ev); setMode('auth-choice'); }} className="w-full text-left p-5 rounded-2xl border border-slate-100 shadow-sm bg-white hover:border-indigo-500 transition">
                   <div className="font-bold text-lg text-slate-800">{ev.name}</div>
                   <div className="text-xs text-indigo-500 font-bold mt-1">Tap to Join</div>
                 </button>
               ))}
             </div>
           </div>
        )}

        {mode === 'auth-choice' && (
          <div className="w-full max-w-sm mt-10 animate-slide-up">
            <button onClick={() => setMode('select')} className="mb-6 text-slate-400 font-bold text-sm">← Back</button>
            <h2 className="text-2xl font-bold text-slate-800 mb-6">{selectedEvent.name}</h2>
            <button onClick={() => setMode('form')} className="w-full p-4 bg-indigo-600 text-white rounded-xl font-bold mb-3 shadow-lg shadow-indigo-200">New Registration</button>
            <button onClick={() => setMode('login')} className="w-full p-4 bg-white border-2 border-slate-100 text-slate-600 rounded-xl font-bold">Log In (Existing)</button>
          </div>
        )}

        {mode === 'form' && (
          <form onSubmit={handleRegister} className="w-full max-w-md animate-fade-in">
             <button type="button" onClick={() => setMode('auth-choice')} className="mb-6 text-slate-400 font-bold text-sm">← Back</button>
             <h2 className="text-2xl font-bold text-slate-800 mb-6">Registration</h2>
             <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-xl flex gap-3 text-xs text-yellow-800"><AlertCircle size={16}/> <b>Action Required:</b> Take a selfie at the venue now for manual verification.</div>
             <div className="space-y-4">
               <input required className="w-full p-4 bg-slate-50 rounded-xl border-2 border-transparent focus:bg-white focus:border-indigo-500 outline-none" placeholder="Full Name" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
               <input required className="w-full p-4 bg-slate-50 rounded-xl border-2 border-transparent focus:bg-white focus:border-indigo-500 outline-none" placeholder="Student ID" value={formData.sid} onChange={e => setFormData({...formData, sid: e.target.value})} />
               <div className="grid grid-cols-2 gap-3">
                  <input required type="email" placeholder="Email" className="w-full p-4 bg-slate-50 rounded-xl outline-none" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} />
                  <input required type="tel" placeholder="Phone" className="w-full p-4 bg-slate-50 rounded-xl outline-none" value={formData.phone} onChange={e => setFormData({...formData, phone: e.target.value})} />
               </div>
             </div>
             <button className="w-full mt-8 p-4 bg-indigo-600 text-white font-bold rounded-xl shadow-xl">Get QR Pass</button>
          </form>
        )}

        {mode === 'login' && (
          <form onSubmit={handleLogin} className="w-full max-w-sm mt-10 animate-fade-in">
            <button type="button" onClick={() => setMode('auth-choice')} className="mb-6 text-slate-400 font-bold text-sm">← Back</button>
            <h2 className="text-2xl font-bold text-slate-800 mb-6">View Pass</h2>
            <input required className="w-full p-4 bg-slate-50 rounded-xl border-2 border-transparent focus:bg-white focus:border-indigo-500 outline-none mb-4" value={loginId} onChange={e => setLoginId(e.target.value)} placeholder="Enter Student ID" />
            <button className="w-full p-4 bg-slate-800 text-white font-bold rounded-xl">View</button>
          </form>
        )}

        {mode === 'dashboard' && myParticipantData && (
          <div className="w-full max-w-md animate-scale-in text-center">
            <div className="flex justify-between items-center mb-6">
               <button onClick={() => setMode('select')} className="text-slate-400 font-bold text-xs">EXIT</button>
               <button onClick={() => setMode('dashboard')} className="text-indigo-600 font-bold text-xs flex gap-1 items-center"><RefreshCcw size={12}/> REFRESH</button>
            </div>
            <div className="bg-white rounded-3xl shadow-xl border border-slate-100 p-8 mb-6 relative overflow-hidden">
               <div className={`absolute top-0 left-0 w-full h-2 ${myParticipantData.status === 'present' ? 'bg-green-500' : myParticipantData.status === 'late' ? 'bg-yellow-500' : myParticipantData.status === 'break' ? 'bg-orange-500' : 'bg-slate-300'}`}></div>
               <div className="flex justify-center mb-6 mt-2"><div className="p-3 bg-white border-4 border-slate-50 rounded-xl"><QRCodeSVG value={`EVENTFLOW:${myParticipantData.student_id}:${selectedEvent.id}`} size={160} /></div></div>
               <h2 className="text-2xl font-bold text-slate-900">{myParticipantData.full_name}</h2>
               <p className="text-slate-400 font-mono text-sm mb-4">{myParticipantData.student_id}</p>
               <div className="inline-block px-4 py-2 rounded-lg text-sm font-bold uppercase bg-slate-100 text-slate-500">STATUS: {myParticipantData.status.replace('_', ' ')}</div>
            </div>
            {selectedEvent.is_open_for_checkout && myParticipantData.status !== 'checked_out' && (
               myParticipantData.status === 'break' ? <div className="p-4 bg-orange-50 text-orange-800 rounded-xl text-sm font-bold border border-orange-100 mb-4">You are on break. Return first to checkout.</div> : 
               <button onClick={selfCheckout} className="w-full py-4 bg-red-500 text-white rounded-xl font-bold shadow-lg shadow-red-200 mb-4 flex items-center justify-center gap-2"><DoorOpen/> TIME OUT NOW</button>
            )}
            {myParticipantData.status === 'checked_out' && <div className="p-4 bg-slate-100 text-slate-500 rounded-xl text-sm font-bold mb-4">Event Completed. Goodbye!</div>}
          </div>
        )}
      </div>
      {mode === 'select' && <div className="p-6 text-center"><button onClick={onStaffAccess} className="text-slate-300 text-xs font-bold hover:text-indigo-600 transition flex items-center justify-center gap-1 mx-auto"><Lock size={12} /> STAFF PORTAL</button></div>}
    </div>
  );
};

// 4. MAIN WRAPPER
export default function App() {
  const [session, setSession] = useState(null);
  const [appMode, setAppMode] = useState('landing');
  const [profile, setProfile] = useState(null);
  const [creds, setCreds] = useState({email:'', pass:''});
  const [adminCreds, setAdminCreds] = useState({user:'', pass:''});
  const [loading, setLoading] = useState(false);
  const [authType, setAuthType] = useState('signin');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => { setSession(session); if(session) checkProfile(session.user.id); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => { setSession(session); if(session) checkProfile(session.user.id); else setProfile(null); });
    return () => subscription.unsubscribe();
  }, []);

  const checkProfile = async (userId) => { const { data } = await supabase.from('profiles').select('*').eq('id', userId).single(); if (data) setProfile(data); };
  
  const handleManagerAuth = async (e) => { 
    e.preventDefault(); setLoading(true); let res;
    if (authType === 'signup') { res = await supabase.auth.signUp({ email: creds.email, password: creds.pass }); if(!res.error) alert("Registered. Wait for approval."); }
    else { res = await supabase.auth.signInWithPassword({ email: creds.email, password: creds.pass }); }
    setLoading(false); if (res.error) alert(res.error.message);
  };

  const handleAdminLogin = (e) => { e.preventDefault(); if (adminCreds.user === 'MJ' && adminCreds.pass === 'VantalStudio2025') { setAppMode('admin-dashboard'); setAdminCreds({user:'', pass:''}); } else alert("Denied."); };

  if (appMode === 'admin-dashboard') return <AdminPanel goBack={() => setAppMode('landing')} />;
  if (session && profile) {
    if (!profile.is_approved) return <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6"><div className="bg-white p-8 rounded-2xl shadow text-center"><h2 className="font-bold text-xl mb-2">Pending Approval</h2><p className="text-slate-500 mb-6">Contact Admin MJ.</p><button onClick={()=>supabase.auth.signOut()} className="font-bold text-indigo-600">Sign Out</button></div></div>;
    return <ManagerDashboard user={session.user} onLogout={() => supabase.auth.signOut()} />;
  }
  
  if (appMode === 'auth-select') return <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex flex-col justify-end md:justify-center p-4 z-50"><div className="bg-white rounded-2xl p-6 shadow-2xl"><div className="flex justify-between mb-6"><h2 className="font-bold text-lg">Staff Access</h2><button onClick={()=>setAppMode('landing')}><X/></button></div><div className="space-y-3"><button onClick={()=>setAppMode('manager-auth')} className="w-full p-4 bg-indigo-50 text-indigo-800 rounded-xl font-bold flex gap-3 items-center"><User/> Manager Login</button><button onClick={()=>setAppMode('admin-auth')} className="w-full p-4 bg-slate-100 text-slate-800 rounded-xl font-bold flex gap-3 items-center"><Shield/> Admin Console</button></div></div></div>;
  
  if (appMode === 'manager-auth') return <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6"><div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-sm"><button onClick={()=>setAppMode('auth-select')} className="text-sm font-bold text-slate-400 mb-4">Back</button><h2 className="text-2xl font-bold mb-6">{authType==='signin'?'Manager Sign In':'Register Manager'}</h2><form onSubmit={handleManagerAuth} className="space-y-4"><input className="w-full p-3 border rounded-lg" placeholder="Email" value={creds.email} onChange={e=>setCreds({...creds, email:e.target.value})} /><input type="password" className="w-full p-3 border rounded-lg" placeholder="Password" value={creds.pass} onChange={e=>setCreds({...creds, pass:e.target.value})} /><button disabled={loading} className="w-full py-3 bg-indigo-600 text-white rounded-lg font-bold">{loading?'...':'Submit'}</button></form><button onClick={()=>setAuthType(authType==='signin'?'signup':'signin')} className="w-full mt-4 text-xs font-bold text-indigo-600">Switch Mode</button></div></div>;
  
  if (appMode === 'admin-auth') return <div className="min-h-screen flex items-center justify-center bg-slate-900 p-6"><div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-sm"><button onClick={()=>setAppMode('auth-select')} className="text-sm font-bold text-slate-400 mb-4">Back</button><h2 className="text-xl font-bold mb-6">Admin Verification</h2><form onSubmit={handleAdminLogin} className="space-y-4"><input className="w-full p-3 border rounded-lg" placeholder="Username" value={adminCreds.user} onChange={e=>setAdminCreds({...adminCreds, user:e.target.value})} /><input type="password" className="w-full p-3 border rounded-lg" placeholder="Password" value={adminCreds.pass} onChange={e=>setAdminCreds({...adminCreds, pass:e.target.value})} /><button className="w-full py-3 bg-slate-900 text-white rounded-lg font-bold">Access</button></form></div></div>;

  return <ParticipantView onStaffAccess={() => setAppMode('auth-select')} />;
}


