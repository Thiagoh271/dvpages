from flask import Flask, render_template, request, session, redirect, url_for, jsonify
from functools import wraps
import os

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'dev-secret-change-in-prod')

SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_ANON_KEY', '')

AUTH_REQUIRED = bool(SUPABASE_URL and SUPABASE_KEY)

supabase = None
if AUTH_REQUIRED:
    try:
        from supabase import create_client
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception as e:
        print(f"[dvpages] Supabase init error: {e}")

def get_user_client():
    if not AUTH_REQUIRED or not SUPABASE_URL or not SUPABASE_KEY:
        return None
    try:
        from supabase import create_client
        client = create_client(SUPABASE_URL, SUPABASE_KEY)
        token = session.get('access_token', '')
        refresh = session.get('refresh_token', '')
        if token:
            client.auth.set_session(token, refresh)
        return client
    except Exception:
        return None

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if AUTH_REQUIRED and 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated

@app.route('/login', methods=['GET', 'POST'])
def login():
    if not AUTH_REQUIRED:
        return redirect(url_for('index'))
    if 'user_id' in session:
        return redirect(url_for('index'))
    error = None
    if request.method == 'POST':
        if supabase is None:
            error = 'Erro interno — tente novamente em instantes'
        else:
            email = request.form.get('email', '').strip()
            password = request.form.get('password', '')
            try:
                res = supabase.auth.sign_in_with_password({'email': email, 'password': password})
                session['user_id'] = res.user.id
                session['user_email'] = res.user.email
                session['access_token'] = res.session.access_token
                session['refresh_token'] = res.session.refresh_token
                return redirect(url_for('index'))
            except Exception:
                error = 'Email ou senha inválidos'
    return render_template('login.html', error=error)

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

@app.route('/')
@login_required
def index():
    user_email = session.get('user_email', '')
    return render_template('index.html', user_email=user_email)

@app.route('/api/save', methods=['POST'])
@login_required
def api_save():
    db = get_user_client()
    if not db:
        return jsonify({'error': 'storage indisponível'}), 503
    data = request.get_json(force=True)
    filename = (data.get('filename') or 'sem-titulo.html').strip()
    html = data.get('html', '')
    user_id = session['user_id']
    try:
        db.table('pages').upsert(
            {'user_id': user_id, 'filename': filename, 'html': html, 'updated_at': 'now()'},
            on_conflict='user_id,filename'
        ).execute()
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/files')
@login_required
def api_files():
    db = get_user_client()
    if not db:
        return jsonify([])
    user_id = session['user_id']
    try:
        res = db.table('pages').select('id,filename,updated_at').eq('user_id', user_id).order('updated_at', desc=True).execute()
        return jsonify(res.data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/load/<file_id>')
@login_required
def api_load(file_id):
    db = get_user_client()
    if not db:
        return jsonify({'error': 'storage indisponível'}), 503
    user_id = session['user_id']
    try:
        res = db.table('pages').select('filename,html').eq('id', file_id).eq('user_id', user_id).single().execute()
        return jsonify(res.data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    print("DvPages rodando em http://localhost:5051")
    app.run(debug=True, port=5051)
