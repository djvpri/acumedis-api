const B = 'https://fctqy79kuiw9c7cddjfdcsgg.103.93.129.94.sslip.io'
const login = async () => {
  const r = await fetch(B + '/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'sentarummedia@gmail.com', password: '5rV9zzmCEc', deviceId: 'uji-setelan' }),
  })
  const d = await r.json()
  if (!d.accessToken) throw new Error('login gagal: ' + JSON.stringify(d))
  return d.accessToken
}
const call = (path, method, token, body) =>
  fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  })

;(async () => {
  const t = await login()

  let r = await call('/v1/settings', 'GET', t)
  console.log('1) GET settings ->', r.status, JSON.stringify(await r.json()).slice(0, 160))

  r = await call('/v1/settings', 'PATCH', t, { clinicName: 'J Akupuntur', address: 'Jl. Merdeka No. 12, Pontianak', phone: '082153533164' })
  console.log('2) PATCH klinik ->', r.status, JSON.stringify(await r.json()))

  r = await call('/v1/practitioners', 'POST', t, { name: 'dr. Uji Dua', email: 'uji.dua@akupuntur.test', password: 'rahasia123', phone: '081200000002', role: 'practitioner' })
  const created = await r.json()
  console.log('3) POST praktisi ->', r.status, created.practitioner && created.practitioner.name)

  const id = created.practitioner?.id
  r = await call('/v1/practitioners/' + id, 'PATCH', t, { name: 'dr. Uji Dua Edit', phone: '081200000003' })
  console.log('4) PATCH praktisi ->', r.status, JSON.stringify(await r.json()).slice(0, 120))

  r = await call('/v1/settings', 'GET', t)
  const s = await r.json()
  console.log('5) jumlah praktisi ->', s.practitioners.length, '| klinik:', s.clinic.clinicName, '|', s.clinic.address, '|', s.clinic.phone)

  r = await call('/v1/practitioners/' + id, 'DELETE', t)
  console.log('6) DELETE (nonaktif) ->', r.status, JSON.stringify(await r.json()).slice(0, 120))

  // validasi: password pendek & email duplikat
  r = await call('/v1/practitioners', 'POST', t, { name: 'X', email: 'x@y.z', password: 'pendek' })
  console.log('7) password pendek ->', r.status)
  r = await call('/v1/practitioners', 'POST', t, { name: 'X', email: 'sentarummedia@gmail.com', password: 'rahasia123' })
  console.log('8) email duplikat ->', r.status)
})()
