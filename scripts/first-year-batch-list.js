/**
 * The official batch split for the 2030 intake.
 *
 * The list was published as names only - no USNs - so the name a volunteer
 * types is the only key we have, and it is a weak one. Three different people
 * on this list are called Shivam Kumar and they landed in three different
 * batches; sixteen first names span more than one batch. So a lookup here
 * either lands on exactly one row or it refuses to guess, and it always tells
 * the caller which of those two happened. Nothing is filled in on a maybe.
 *
 * Rows are 'section|name', transcribed from FINAL batch list.pdf and verified
 * against its per-section counts: 1A 58, 1B 58, 2A 58, 2B 57.
 */

const ROSTER = `
1A|Hasini Anugu
1A|Aiesha Shaik
1A|Vanshika Sharma
1A|Hari Sri SasiVathana G
1A|Piushi sharma
1A|Shweta Bilhare
1A|Rishika Agrawal
1A|Harshita Dhakad
1A|TVESHA MILAP VAISHNAV
1A|Anshika Indu
1A|Manjushree Chabbi
1A|MAGHAM GANA SHYAM LAKSHMI SREENIVAS
1A|Thadi Daniel Ratan Babu
1A|Tejas Dharmendra Patel
1A|Ashvanth Gandham
1A|JARVIS JEASON JACOB
1A|D.sai vishal
1A|Bhavesh Singh
1A|Soham Mishra
1A|Prince Sanjaybhai Rabadiya
1A|K.Eshanth Reddy
1A|Rishabh Kumar Samal
1A|Rishabh Agrawal
1A|Shubh Bhardwaj
1A|Abhishek
1A|Prince Sharma
1A|Manav Dugar
1A|Sujal Jangde
1A|Vaibhav Gupta
1A|Bhavyarajsinh B Amala
1A|Prashant Saini
1A|Hrishant Malviya
1A|Kavin Rau
1A|LUCKY
1A|Ishan Kumar
1A|Bikramjit Sil
1A|Sagir Alam Sk
1A|Konduru Lakshmi Sai Praneeth
1A|Ujjwal Dubey
1A|VISHESH KUMAR DHAKER
1A|Saksham Jaiswal
1A|Nikhil Aryan
1A|Sourav Paul
1A|SAMYAK JAIN
1A|PRANTIK SARKAR
1A|Darshil P Jain
1A|KAKUL KASHYAP DEKA
1A|PRANSHU .
1A|Kartik Sharma
1A|Shiv Sagar Kumar Mandal
1A|Sumit lal
1A|Nihar Akshai
1A|Vedant Saware
1A|Sambhav Singhal
1A|Yashwendra Pratap Singh
1A|Ayush Nagar
1A|kartik khandelwal
1A|vardaan
1B|Mahaswi Kuttuboyina
1B|Srija Sikly
1B|Dauris Jain
1B|Naincy Meravi
1B|Vidyanshi Rajwadha
1B|Srishti .
1B|Anindita Das
1B|Swasti Soumyaa Nayak
1B|Harsha kohale
1B|vaibhvi
1B|Musarafa Khatun
1B|Sravan Gupta Samudrala
1B|Adhithya Pandiri
1B|kandula venkata vishaleswar reddy
1B|kunal suryavanshi
1B|tejas rastogi
1B|Swastik Katiyar
1B|Akash Ramanathan Iyer
1B|Archisman Pal
1B|Ronin Saxena
1B|EJAZ AHAMED KHAN
1B|Jayvir
1B|Manav Chhajer
1B|Mayuresh Sonawane
1B|Arnav Sharma
1B|Prathamesh Kanase
1B|Shubham Ray
1B|garv sanveria
1B|Nishpray Singh
1B|Ojasva Vardhan Sharma
1B|Aryan Swaroop
1B|Aditya Mishra
1B|Akhilesh Nitharwal
1B|Divyanshu singh
1B|Umair Shaikh
1B|Sudipta Kuila
1B|ABHIRUP KARMAKAR
1B|SAISASAI VEERA BALLE
1B|Rudraksh Sitoke
1B|Omkar Kargal
1B|Sachin Kumar
1B|Ayush Khajuria
1B|Shaurya gupta
1B|Adithya Ramesh
1B|HRIDHIN VARKEY JOSEPH
1B|Aryan Dixit
1B|Divyansh Kushwaha
1B|Vedant Saini
1B|Nitin Nehra
1B|Yash Arya
1B|Baibhav Kumar
1B|Srivathsa
1B|SUJAL SWARAJ
1B|Shivam Singh
1B|Aryan Raj
1B|Aryan Sirohi
1B|SHIVAM KUMAR
1B|Snehal S N
2A|KUNCHAM LASYA KRISHNA
2A|Aruna Ramanathan Iyer
2A|M N Dwani
2A|Yashvi Surana
2A|RATHAVA DIPIKA
2A|Namya Sahu
2A|Arushi
2A|Aadishree Joshi
2A|Reva Bharol
2A|Ananya Pathak
2A|Dilreet Kaur
2A|Balaji Bonthu
2A|H Nishanth Rao
2A|Charan
2A|Pushwanth R Reddy
2A|Lakshmi Charan Donepudi
2A|B Aadarsh
2A|ARMAAN SAXENA
2A|Sanjay Singh
2A|Himanshu Giri
2A|Abhijay Pillai
2A|Shikhar Kumar Prasad
2A|Harsh Pandey
2A|NEERAJ KUMAR SAHU
2A|Shaurya Agarwal
2A|Vedish Bansal
2A|Vinay shambuling Bichchali
2A|Raghav sharma
2A|Harshit Raj
2A|Harsh Nahar
2A|Abdul malik Khan
2A|Aryan Pandey
2A|Kanishk Patel
2A|Akshat Singh
2A|Ayaan Kapoor
2A|Yash Panchal
2A|Asmit Bairagi
2A|Pranav Sankhyan
2A|Arham Ahsan Safdari
2A|HARSHIT KANDPAL
2A|Arjun Shukla
2A|Aryan
2A|Aditya Tulo
2A|Anuj Preet
2A|Sk Firdous
2A|Anuraj Prafulla Satav
2A|Aryan Patel
2A|Shivam kumar
2A|Atharva Gavhane
2A|Sabhya
2A|Aviral Srivastava
2A|aryan verma
2A|KARTIK YADAV
2A|Pranay Ranjan
2A|Laltesh Chaudhary
2A|Arush Prasad
2A|AKSHAT CHAUHAN
2A|Lekhraj
2B|Srushti
2B|Manasvini Punuru
2B|Vaishnavi Dhakwal
2B|Shambhavi Sharma
2B|Sahishna Kadam
2B|Liza
2B|Twinkle .
2B|PRACHI DARSHI
2B|Vaishnavi Choudhary
2B|Ishita roy
2B|Garvi Pounikar
2B|Abdul Mannan
2B|Kovid Jain
2B|Trishan Ghosh
2B|Mehul Pundir Negi
2B|Prithvi Kumar Singh
2B|Om Shukla
2B|Chethan Chowdhary Kantamneni
2B|Rajnish Pathak
2B|Yashwanth Raj
2B|AKSHIT Sharma
2B|Aayush Raj
2B|Jeevan Basappa Bagi
2B|Shubhrodeep Sur
2B|Sushant Kumar
2B|Ansh Saxena
2B|Kunal Singh Parmar
2B|Aditya Goyal
2B|AdityaRaj Singh
2B|Kirtan Maulik Joshi
2B|Anupam Kislay
2B|Aditya Jha
2B|Shriyansh Tamta
2B|AYAAN KHAN
2B|Akshat Pratap Singh Bhadauria
2B|Divyansh Pal
2B|Chanchal Agarwal
2B|Sudhansu Tiwari
2B|Varun pateriya
2B|Het
2B|Shashank ojha
2B|Vikas Shukla
2B|Dhairya Agrawal
2B|Anurag singh
2B|Vineet Vaibhav
2B|Arman Sohil Vadhvania
2B|Apurv Tiwari
2B|Dhairya Dev Singh
2B|Jaydeep Biswas
2B|MOHIT KUMAR
2B|ANSARI MOHAMMED OSMAN
2B|Tanishq
2B|Mohit Krishna Prasad
2B|Mayank Suthar
2B|Ansh
2B|Shivam Kumar
2B|Krishna Chandan
`;

// Punctuation is noise here: the list carries "PRANSHU .", "D.sai vishal" and
// "kartik khandelwal" as written, and a volunteer will not reproduce any of it.
function normalize(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const ENTRIES = ROSTER.trim().split('\n').map((line) => {
    const [code, name] = line.split('|');
    const batch = 'Batch ' + code[0];
    const section = code[1];
    const key = normalize(name);
    return { name, batch, section, label: batch + ' ' + section, key, tokens: key.split(' ').filter(Boolean) };
});

// A name resolves only when every row it could possibly be agrees on the same
// batch and section. Two rows both reading "Ansh" in 2B is not a problem; the
// three Shivam Kumars in 1B, 2A and 2B are.
function settle(candidates, status) {
    const labels = new Set(candidates.map((c) => c.label));
    if (labels.size === 1) {
        const [first] = candidates;
        return {
            status,
            batch: first.batch,
            section: first.section,
            label: first.label,
            matched: candidates.map((c) => c.name)
        };
    }
    return {
        status: 'ambiguous',
        batch: '',
        section: '',
        label: '',
        candidates: candidates.map((c) => ({ name: c.name, batch: c.batch, section: c.section, label: c.label }))
    };
}

/**
 * Resolve a typed name to its batch.
 *
 * status is one of:
 *   exact     - the name matches a roster row outright
 *   partial   - the typed name is a subset of one row, or the row of the typed
 *               name. Volunteers type what the student says ("Faizan" for
 *               "Mohd Faizan Khan"), so this carries the common case rather
 *               than failing it
 *   ambiguous - it could be more than one person and they are not in the same
 *               batch, so the caller has to ask instead of picking
 *   none      - not on the official list at all
 */
function lookupBatch(rawName) {
    const key = normalize(rawName);
    if (!key) return { status: 'none', batch: '', section: '', label: '' };

    const typed = key.split(' ').filter(Boolean);
    const exact = ENTRIES.filter((e) => e.key === key);

    // A full-name exact match is strong enough to stand on its own: "Aryan
    // Dixit" is the Aryan Dixit on the list, not the person recorded only as
    // "Aryan" who could in principle share the surname. Two or more tokens is
    // the bar - one is not specific enough to earn it.
    if (exact.length && typed.length > 1) return settle(exact, 'exact');

    // Below that bar an exact hit does not end the search. One student is
    // listed as bare "Aryan" in 2A, but seven others are Aryan-something
    // across two batches, and a volunteer typing "Aryan" has told us nothing
    // about which. So looser matches are gathered too and any disagreement
    // between them wins.
    const partial = ENTRIES.filter((e) => {
        if (e.key === key) return false;
        const coversTyped = typed.every((t) => e.tokens.includes(t));
        const coveredByTyped = e.tokens.every((t) => typed.includes(t));
        return coversTyped || coveredByTyped;
    });

    const all = exact.concat(partial);
    if (!all.length) return { status: 'none', batch: '', section: '', label: '' };
    return settle(all, exact.length ? 'exact' : 'partial');
}

const SECTION_LABELS = [...new Set(ENTRIES.map((e) => e.label))].sort();

module.exports = { ENTRIES, SECTION_LABELS, lookupBatch, normalize, ROSTER_SIZE: ENTRIES.length };
